import { createHash } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { contentSnapshotSchema } from "@bh/core-game/src/content/snapshot-schema";
import type { ContentSnapshot } from "@bh/core-game/src/content/snapshot";
import { simulateBalanceRun, type BalanceRunOptions, type BalanceRunResult } from "@bh/core-game/src/game/balance";
import { findContentProblems } from "@bh/core-game/src/game/content-problems";
import { unlocksAt } from "@bh/core-game/src/game/progression/unlocks";
import type { DifficultyId } from "@bh/shared-types";
import { checkJobSchema, jsonBytes, type CheckJob, type ScenarioSpec } from "./job";
import { BASE_CACHE_MAX, MAX_PROBLEMS, RUN_LIMIT_MS, SNAPSHOT_MAX_BYTES, SNAPSHOT_TOO_LARGE } from "./limits";
import { corridorsOf, deltaOf, mediansOf, type CheckReport, type CheckResult, type Problem, type ScenarioReport, type SideRuns } from "./report";

export type { CheckResult, CheckReport, Problem, ScenarioReport } from "./report";

/** Прогоны базы по версии базы и сценарию: у многих черновиков одна база, и считать её каждый раз незачем. */
export type BaseRunCache = Map<string, BalanceRunResult[]>;

/** Что можно подменить: часы и прогон в тестах, кэш и предел — на уровне воркера. */
export interface CheckDeps {
  /** монотонные часы, мс */
  now?: () => number;
  limitMs?: number;
  simulate?: (options: BalanceRunOptions) => BalanceRunResult;
  /** отдать управление циклу событий: иначе очередь сочтёт задание зависшим, а метрики замрут */
  yieldToLoop?: () => Promise<void>;
  baseRuns?: BaseRunCache;
}

/** Сложность, на которой заданы коридоры калибровки: остальные идут отдельными строками свода. */
const BASE_DIFFICULTY = "easy";

/**
 * Сценарии по умолчанию — те же, что собирает `pnpm balance:sim` для «Лёгкой»:
 * пассивный бот на первом стартовом оружии и уклоняющийся на каждом. Стартовое
 * оружие — открытое на первом уровне аккаунта, как у новичка; прочие сложности
 * и уровни аккаунта в отчёт по умолчанию не входят — коридоры заданы не для них.
 */
export function defaultScenarios(snapshot: ContentSnapshot): ScenarioSpec[] {
  const open = unlocksAt(snapshot.accountUnlocks, 1).weapons;
  const starting = snapshot.weapons.filter((weapon) => weapon.evolvedFrom === undefined && open.has(weapon.id)).map((weapon) => weapon.id);
  const scenarios: ScenarioSpec[] = [];
  const first = starting[0];
  if (first !== undefined) scenarios.push({ id: `passive / ${first}`, skill: "passive", startingWeaponId: first, difficultyId: BASE_DIFFICULTY });
  for (const id of starting) scenarios.push({ id: `dodging / ${id}`, skill: "dodging", startingWeaponId: id, difficultyId: BASE_DIFFICULTY });
  return scenarios;
}

/** Снимок из очереди: размер, затем схема. Проблемы называют путь до поля. */
function validate(value: unknown, root: "snapshot" | "baseSnapshot"): { snapshot: ContentSnapshot | null; problems: Problem[] } {
  if (jsonBytes(value) > SNAPSHOT_MAX_BYTES) return { snapshot: null, problems: [{ path: root, message: SNAPSHOT_TOO_LARGE }] };
  const parsed = contentSnapshotSchema.safeParse(value);
  if (parsed.success) return { snapshot: parsed.data, problems: [] };
  const problems = parsed.error.issues.slice(0, MAX_PROBLEMS).map((issue): Problem => {
    const path = issue.path.map(String).join(".");
    return { path: root === "snapshot" ? path || root : path === "" ? root : `${root}.${path}`, message: issue.message };
  });
  return { snapshot: null, problems };
}

/** Версия базы для кэша: по содержимому JSON, а не по номеру задания. */
const hashOf = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

interface Context {
  expired: () => boolean;
  simulate: NonNullable<CheckDeps["simulate"]>;
  yieldToLoop: NonNullable<CheckDeps["yieldToLoop"]>;
  baseRuns: BaseRunCache;
  baseKey: string;
}

/** Прогоны сценария на одной стороне: для коридоров, `null` — не досчитан. */
interface Entry {
  spec: ScenarioSpec;
  runs: BalanceRunResult[] | null;
}

/** Прогон одной стороны: зёрна 1…N подряд. `null` — предел времени вышел, не досчитали. */
async function runSeeds(content: ContentSnapshot, spec: ScenarioSpec & { seeds: number }, difficultyId: DifficultyId, context: Context): Promise<BalanceRunResult[] | null> {
  const runs: BalanceRunResult[] = [];
  for (let seed = 1; seed <= spec.seeds; seed += 1) {
    if (context.expired()) return null;
    runs.push(
      context.simulate({
        seed,
        skill: spec.skill,
        content,
        difficultyId,
        ...(spec.startingWeaponId === undefined ? {} : { startingWeaponId: spec.startingWeaponId }),
        ...(spec.accountLevel === undefined ? {} : { accountLevel: spec.accountLevel }),
      }),
    );
    await context.yieldToLoop();
  }
  return runs;
}

/** Отчёт по сценарию до прогона: ничего не посчитано. */
function emptyScenario(spec: ScenarioSpec & { seeds: number }): ScenarioReport {
  return { id: spec.id, skill: spec.skill, startingWeaponId: spec.startingWeaponId ?? null, difficultyId: spec.difficultyId ?? BASE_DIFFICULTY, accountLevel: spec.accountLevel ?? null, seeds: spec.seeds, draft: null, base: null, delta: null, error: null, skipped: false };
}

/** Сложность из сценария должна быть и в черновике, и в базе: иначе движок молча взял бы «Лёгкую». */
function resolveDifficulty(spec: ScenarioSpec, draft: ContentSnapshot, base: ContentSnapshot): { id: DifficultyId } | { error: string } {
  const wanted = spec.difficultyId ?? BASE_DIFFICULTY;
  const inDraft = draft.difficulties.find((level) => level.id === wanted);
  const inBase = base.difficulties.find((level) => level.id === wanted);
  return inDraft !== undefined && inBase !== undefined ? { id: inDraft.id } : { error: `сложности «${wanted}» нет в одном из снимков` };
}

const SIDE_EMPTY: SideRuns = { passive: [], dodging: [], complete: { passive: true, dodging: true } };

/** Прогоны, годные для коридоров: «Лёгкая», без уровня аккаунта — как в своде калибровки. */
function corridorRuns(entries: readonly Entry[]): SideRuns {
  const side = { passive: [] as BalanceRunResult[], dodging: [] as BalanceRunResult[], complete: { passive: true, dodging: true } };
  for (const { spec, runs } of entries) {
    if ((spec.difficultyId ?? BASE_DIFFICULTY) !== BASE_DIFFICULTY || spec.accountLevel !== undefined) continue;
    if (runs === null) side.complete[spec.skill] = false;
    else side[spec.skill].push(...runs);
  }
  return side.passive.length + side.dodging.length === 0 && side.complete.passive && side.complete.dodging ? SIDE_EMPTY : side;
}

/**
 * Проверить черновик контента против базы (docs/35-stage4-plan.md Р15,
 * docs/19-content-admin.md §4.3): схема, проверки контента и симуляция
 * сценариев ботом калибровки — на черновике и на базе, с медианами, дельтами и
 * сверкой с коридорами.
 *
 * Снимок не по схеме или больше 2 МБ — проблемы схемы и ничего больше:
 * проверять и гонять нечего. Проблемы контента симуляцию не останавливают:
 * правка не должна терять отчёт из-за одного замечания, а сценарий, который
 * движок не принял, помечается ошибкой отдельно.
 *
 * Прогон длинный и занимает процессор целиком, поэтому между прогонами
 * управление отдаётся циклу событий (иначе очередь решит, что задание
 * зависло), а предел времени проверяется перед каждым прогоном: уложиться в
 * него «посреди» одного забега нельзя, но он короткий.
 */
export async function runCheck(raw: unknown, deps: CheckDeps = {}): Promise<CheckResult> {
  const now = deps.now ?? (() => performance.now());
  const started = now();
  const job: CheckJob = checkJobSchema.parse(raw);
  const elapsed = (): number => Math.round(now() - started);
  const result = (partial: Pick<CheckResult, "schemaProblems" | "contentProblems" | "report">): CheckResult => ({ checkId: job.checkId, ...partial, elapsedMs: elapsed() });

  const draftChecked = validate(job.snapshot, "snapshot");
  const baseChecked = validate(job.baseSnapshot, "baseSnapshot");
  const schemaProblems = [...draftChecked.problems, ...baseChecked.problems].slice(0, MAX_PROBLEMS);
  const draft = draftChecked.snapshot;
  const base = baseChecked.snapshot;
  if (draft === null || base === null) return result({ schemaProblems, contentProblems: [], report: null });

  const contentProblems = findContentProblems(draft).slice(0, MAX_PROBLEMS);
  const limitMs = deps.limitMs ?? RUN_LIMIT_MS;
  const context: Context = {
    expired: () => now() - started >= limitMs,
    simulate: deps.simulate ?? simulateBalanceRun,
    yieldToLoop: deps.yieldToLoop ?? (async () => void (await nextTurn())),
    baseRuns: deps.baseRuns ?? new Map(),
    baseKey: hashOf(job.baseSnapshot),
  };
  // Черновик, ничем не отличающийся от базы, — частый первый заход из редактора. Забег детерминирован,
  // поэтому прогоны базы равны прогонам черновика, и считать их второй раз незачем.
  const unchanged = hashOf(job.snapshot) === context.baseKey;

  const specs = (job.scenarios.length > 0 ? job.scenarios : defaultScenarios(base)).map((spec) => ({ ...spec, seeds: spec.seeds ?? job.seeds }));
  const scenarios: ScenarioReport[] = [];
  const draftEntries: Entry[] = [];
  const baseEntries: Entry[] = [];
  let timeout = false;

  for (const spec of specs) {
    const difficulty = resolveDifficulty(spec, draft, base);
    if ("error" in difficulty) {
      scenarios.push({ ...emptyScenario(spec), error: difficulty.error });
      draftEntries.push({ spec, runs: null });
      baseEntries.push({ spec, runs: null });
      continue;
    }
    let draftRuns: BalanceRunResult[] | null = null;
    let baseRuns: BalanceRunResult[] | null = null;
    try {
      draftRuns = timeout ? null : await runSeeds(draft, spec, difficulty.id, context);
      const cacheKey = `${context.baseKey}|${JSON.stringify([spec.skill, spec.startingWeaponId, spec.difficultyId, spec.accountLevel, spec.seeds])}`;
      baseRuns = context.baseRuns.get(cacheKey) ?? null;
      if (baseRuns === null && draftRuns !== null) {
        baseRuns = unchanged ? draftRuns : await runSeeds(base, spec, difficulty.id, context);
        if (baseRuns !== null) remember(context.baseRuns, cacheKey, baseRuns);
      }
    } catch (error: unknown) {
      scenarios.push({ ...emptyScenario(spec), error: error instanceof Error ? error.message.slice(0, 300) : "сценарий не посчитался" });
      draftEntries.push({ spec, runs: null });
      baseEntries.push({ spec, runs: null });
      continue;
    }
    draftEntries.push({ spec, runs: draftRuns });
    baseEntries.push({ spec, runs: baseRuns });
    if (draftRuns === null || baseRuns === null) {
      timeout = true;
      scenarios.push({ ...emptyScenario(spec), skipped: true });
      continue;
    }
    const draftMedians = mediansOf(draftRuns);
    const baseMedians = mediansOf(baseRuns);
    scenarios.push({ ...emptyScenario(spec), draft: draftMedians, base: baseMedians, delta: deltaOf(draftMedians, baseMedians) });
  }

  const report: CheckReport = {
    timeout,
    seeds: job.seeds,
    scenarios,
    corridors: corridorsOf(draft, base, corridorRuns(draftEntries), corridorRuns(baseEntries)),
  };
  return result({ schemaProblems, contentProblems, report });
}

/** Кэш с потолком: самый старый уходит первым. */
function remember(cache: BaseRunCache, key: string, runs: BalanceRunResult[]): void {
  cache.delete(key);
  cache.set(key, runs);
  while (cache.size > BASE_CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
}
