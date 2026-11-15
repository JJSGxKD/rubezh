import { setImmediate as nextTurn } from "node:timers/promises";
import { CONTENT_HASH } from "@bh/core-game/src/content/hash";
import { hashSnapshot, type ContentSnapshot } from "@bh/core-game/src/content/snapshot";
import { contentSnapshotSchema } from "@bh/core-game/src/content/snapshot-schema";
import { replaySteps, type ReplayOptions, type ReplayOutcome, type ReplaySource, type ReplayVerdict } from "@bh/core-game/src/game/diagnostics/replay";
import { RUN_PROOF_SCHEMA, type RunRecordingResult } from "@bh/core-game/src/run-api";
import { DIFFICULTY_IDS, LOADOUT_STATS, RUN_MODES, type DifficultyId, type RunMode } from "@bh/shared-types";
import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";
import { jsonBytes } from "./job";
import { SNAPSHOT_MAX_BYTES, SNAPSHOT_TOO_LARGE } from "./limits";
import { logEvent, logThrottled } from "./log";
import type { Metrics } from "./metrics";

/**
 * Очередь `replay` (docs/35-stage4-plan.md Р15, WP5, tasks/T-0318): вторая работа
 * воркера после проверки черновика контента — перепроверка забегов. Сервер ставит
 * задание с записью для проверки (T-0316), снимком контента по её хэшу и тем, что
 * клиент заявил об итоге; воркер прогоняет ту же симуляцию, что `pnpm replay`, и
 * отдаёт исход — совпал ли забег и на каком тике разошёлся. Что делать с исходом,
 * решает сервер (T-0319): воркер ничего не наказывает и не награждает.
 */

/** Имя очереди — в том же Redis, что и очереди сервера. */
export const REPLAY_QUEUE = "replay";

/** Один повтор — не дольше этого: дольше — `timeout`. Время ожидания затвора в предел не входит. */
export const REPLAY_LIMIT_MS = 60_000;

/**
 * Больше шагов в логе ввода воркер не разбирает: лог описывает шаги числом, и без потолка
 * запись с `ticks` в миллиарды потребовала бы гигабайты под коды ещё до первого шага.
 * Миллион шагов — больше четырёх часов мира; честный забег лежит на порядок ниже.
 */
export const REPLAY_MAX_TICKS = 1_000_000;

/**
 * Насколько заявленное время может отличаться от времени повтора. Клиент отдаёт его то целым
 * числом секунд, то дробным, и округление в любую сторону — не подлог; секунда рейтингу ничего не даёт.
 */
export const CLAIM_SEC_TOLERANCE = 1;

const count = z.number().int().nonnegative();
const id = z.string().max(64);

/**
 * Запись для проверки (`run-proof-v1`) в той форме, в какой её принимает сервер
 * (`backend/api/src/modules/runs/dto/run-proof.dto.ts`) — плюс потолок шагов лога и перечни из игры
 * вместо произвольных строк: воркер собирает по ней мир, а не хранит. Запись не по схеме —
 * `broken` в исходе, а не падение задания: это данные игрока.
 */
const proofSchema = z.object({
  schema: z.literal(RUN_PROOF_SCHEMA),
  runId: z.string().min(1).max(64),
  seed: z.number().int(),
  mapId: id,
  difficultyId: z.custom<DifficultyId>((value) => typeof value === "string" && DIFFICULTY_IDS.includes(value as DifficultyId), "такой сложности нет в игре"),
  mode: z.custom<RunMode>((value) => typeof value === "string" && RUN_MODES.includes(value as RunMode), "такого режима нет в игре"),
  startingWeaponId: id,
  contentHash: id,
  unitScale: z.number().positive().max(10),
  loadout: z.object({
    modifiers: z.partialRecord(z.enum(LOADOUT_STATS), z.number().finite().nonnegative().max(1000)),
    boosts: z.array(id).max(8),
    accountLevel: z.number().int().min(1).max(1000).optional(),
  }),
  deviceClass: z.string().max(16).optional(),
  input: z.object({
    encoding: z.literal("rle-v1"),
    ticks: count.max(REPLAY_MAX_TICKS),
    data: z
      .string()
      .max(64_004)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
    truncated: z.boolean(),
  }),
  choices: z.array(z.tuple([count, id])).max(4000),
  continues: z.array(count).max(5),
  checkpoints: z.array(z.tuple([count, z.number().int()])).max(720),
  result: z.object({
    ticks: count,
    survivalSec: z.number().nonnegative(),
    level: count,
    enemiesKilled: count,
    deathCause: id.nullable(),
    checksum: z.number().int(),
  }),
});

/** Итог, который клиент заявил серверу: время, уровень, убийства и — если сервер его хранит — контрольная сумма. */
const claimedSchema = z.strictObject({
  survivalSec: z.number().min(0).max(86_400),
  level: z.number().int().min(0).max(1_000_000),
  enemiesKilled: z.number().int().min(0).max(1_000_000),
  checksum: z.number().int().optional(),
});

/**
 * Задание очереди `replay`. Запись и снимок — `unknown`: их форму разбирают свои схемы и называют
 * проблему в исходе, а не роняют задание. Снимок `null` — хэш записи равен хэшу контента, который
 * встроен в сборку воркера. Идентификатор забега — только для ответа: задание им не помечается.
 */
export const replayJobSchema = z.strictObject({
  runId: z.string().min(1).max(64),
  proof: z.unknown().refine((value) => value !== undefined, "нет записи для проверки"),
  contentSnapshot: z.unknown().default(null),
  claimed: claimedSchema,
});

export type ReplayJob = z.output<typeof replayJobSchema>;
export type ReplayJobInput = z.input<typeof replayJobSchema>;
type Claimed = z.output<typeof claimedSchema>;

/** Вердикты `pnpm replay` и `timeout`: повтор не уложился в предел времени. */
export type ReplayJobVerdict = ReplayVerdict | "timeout";

/** Итог повтора для сервера: без причины смерти — сервер её сверяет сам, по своей записи. */
export interface ReplayedResult {
  ticks: number;
  survivalSec: number;
  level: number;
  enemiesKilled: number;
  checksum: number;
}

/** Исход задания: возвращается тем же заданием — сервер читает его событием завершения. */
export interface ReplayResult {
  runId: string;
  verdict: ReplayJobVerdict;
  /** что пошло не так — для разбора модератором; у `match` пусто */
  reason: string | null;
  /**
   * Где повтор впервые разошёлся с записью (тик свёртки минуты, выбора или второго шанса). Пусто, если не
   * разошёлся или разошёлся только итог с заявленным: тика у такого расхождения нет.
   */
  divergedTick: number | null;
  /** что насчитал повтор; пусто, если повтор не дошёл до итога */
  replayed: ReplayedResult | null;
  durationMs: number;
}

/** Что можно подменить: часы и повтор в тестах, предел — на уровне воркера. */
export interface ReplayDeps {
  /** монотонные часы, мс */
  now?: () => number;
  limitMs?: number;
  /** повтор по частям; по умолчанию — настоящий `replaySteps` движка */
  replay?: (source: ReplaySource, contentHash: string, options: ReplayOptions) => Iterator<unknown, ReplayOutcome, undefined>;
  /** отдать управление циклу событий: иначе очередь сочтёт задание зависшим, а метрики и `/health` замрут */
  yieldToLoop?: () => Promise<void>;
}

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "форма не сошлась";
  const path = issue.path.map(String).join(".");
  return (path === "" ? issue.message : `${path}: ${issue.message}`).slice(0, 200);
}

/**
 * Контент для повтора: снимок из задания или встроенный в сборку. Снимок проверяется схемой и хэшем:
 * неверный — это наша сторона (сервер приложил не тот снимок), и расхождением игрока такой повтор
 * не считается, поэтому все отказы здесь — `content_mismatch`. Хэш считается по снимку, как он
 * пришёл, а не по разобранному схемой: порядок ключей входит в хэш (`hashSnapshot`), и в мир идёт
 * тот же объект, на котором хэш сошёлся.
 */
function resolveContent(snapshot: unknown, contentHash: string): { content: ContentSnapshot | null } | { problem: string } {
  if (snapshot === null) {
    return contentHash === CONTENT_HASH ? { content: null } : { problem: `запись снята на контенте ${contentHash}, в воркере ${CONTENT_HASH}, снимка в задании нет` };
  }
  if (jsonBytes(snapshot) > SNAPSHOT_MAX_BYTES) return { problem: SNAPSHOT_TOO_LARGE };
  const parsed = contentSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) return { problem: `снимок контента не по схеме: ${describeIssue(parsed.error)}` };
  // Схема только что подтвердила форму; разобранную копию в мир не берём — см. выше про порядок ключей.
  const verified = snapshot as ContentSnapshot;
  const actual = hashSnapshot(verified);
  return actual === contentHash ? { content: verified } : { problem: `хэш снимка ${actual}, а запись снята на контенте ${contentHash}` };
}

/** Итог повтора против заявленного клиентом: что не сошлось, одной строкой; `null` — сошлось. */
function claimProblem(claimed: Claimed, actual: RunRecordingResult): string | null {
  const problems: string[] = [];
  if (Math.abs(claimed.survivalSec - actual.survivalSec) > CLAIM_SEC_TOLERANCE) problems.push(`время ${String(claimed.survivalSec)} с, повтор ${String(actual.survivalSec)} с`);
  if (claimed.level !== actual.level) problems.push(`уровень ${String(claimed.level)}, повтор ${String(actual.level)}`);
  if (claimed.enemiesKilled !== actual.enemiesKilled) problems.push(`убийства ${String(claimed.enemiesKilled)}, повтор ${String(actual.enemiesKilled)}`);
  if (claimed.checksum !== undefined && claimed.checksum !== actual.checksum) problems.push(`контрольная сумма ${String(claimed.checksum)}, повтор ${String(actual.checksum)}`);
  return problems.length === 0 ? null : `итог разошёлся с заявленным: ${problems.join("; ")}`;
}

/**
 * Повторить забег по записи (docs/28-diagnostics.md §3.4): тот же мир, тот же ввод, те же выборы,
 * что в сцене, — и сверка. Сверяются свёртки мира по пути (первое расхождение даёт тик), итог повтора
 * с итогом записи и, если повтор совпал, итог повтора с тем, что клиент заявил серверу: запись могла
 * быть честной, а заявка — завышенной.
 *
 * Запись и снимок — данные из очереди: что не сошлось с их формой, называется в исходе. Падает
 * задание только от формы самого задания (нет идентификатора забега или заявки): так выглядит
 * чужой или старый производитель, и воркеру отвечать некому. Исключение внутри повтора — `broken`:
 * забег игрока не вина игрока, но и наказывать за него нечем.
 *
 * Повтор идёт частями (`replaySteps`): между частями управление отдаётся циклу событий, а предел
 * времени проверяется перед каждой следующей — прервать часть посреди нельзя, но она короткая.
 * Время ожидания затвора процесса (`RunGate`) в предел не входит: оно считается от первой части.
 */
export async function runReplay(raw: unknown, deps: ReplayDeps = {}): Promise<ReplayResult> {
  const now = deps.now ?? (() => performance.now());
  const started = now();
  const job = replayJobSchema.parse(raw);
  const result = (verdict: ReplayJobVerdict, reason: string | null, extra: { divergedTick?: number | null; replayed?: ReplayedResult | null } = {}): ReplayResult => ({
    runId: job.runId,
    verdict,
    reason,
    divergedTick: extra.divergedTick ?? null,
    replayed: extra.replayed ?? null,
    durationMs: Math.round(now() - started),
  });

  const parsed = proofSchema.safeParse(job.proof);
  if (!parsed.success) return result("broken", `запись не по схеме: ${describeIssue(parsed.error)}`);
  const proof = parsed.data;
  // Как `replayRecording`: запись, помеченная неповторимой, не повторяется, какой бы у неё ни был контент.
  if (proof.input.truncated) return result("not_replayable", "input_overflow");

  const resolved = resolveContent(job.contentSnapshot, proof.contentHash);
  if ("problem" in resolved) return result("content_mismatch", resolved.problem);

  const source: ReplaySource = { ...proof, deviceClass: proof.deviceClass === "light" ? "light" : "standard" };
  const limitMs = deps.limitMs ?? REPLAY_LIMIT_MS;
  const yieldToLoop = deps.yieldToLoop ?? (async () => void (await nextTurn()));
  let outcome: ReplayOutcome;
  let steps: Iterator<unknown, ReplayOutcome, undefined> | null = null;
  try {
    steps = (deps.replay ?? replaySteps)(source, proof.contentHash, resolved.content === null ? {} : { content: resolved.content });
    for (;;) {
      const next = steps.next();
      if (next.done === true) {
        outcome = next.value;
        break;
      }
      if (now() - started >= limitMs) return result("timeout", `повтор не уложился в ${String(limitMs / 1000)} с`);
      await yieldToLoop();
    }
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message.slice(0, 200) : "причина неизвестна";
    logEvent("warn", "replay_threw", { reason });
    return result("broken", `повтор не удался: ${reason}`);
  } finally {
    // Недосчитанный повтор закрывается: мир с тысячами врагов не должен ждать сборщика мусора в замыкании.
    steps?.return?.();
  }

  const actual = outcome.actual;
  const replayed: ReplayedResult | null =
    actual === null ? null : { ticks: actual.ticks, survivalSec: actual.survivalSec, level: actual.level, enemiesKilled: actual.enemiesKilled, checksum: actual.checksum };
  if (outcome.verdict === "match" && actual !== null) {
    const problem = claimProblem(job.claimed, actual);
    if (problem !== null) return result("mismatch", problem, { replayed });
  }
  return result(outcome.verdict, outcome.reason, { replayed, divergedTick: outcome.divergedAtTick });
}

/** Порядок полос затвора: чем раньше, тем выше приоритет. Проверку контента ждёт человек в панели. */
const GATE_LANES = { check: 0, replay: 1 } as const;
export type GateLane = keyof typeof GATE_LANES;

/**
 * Затвор процесса: тяжёлая работа воркера — проверка черновика и повтор забега — идёт по одной, потому что
 * каждая занимает процессор целиком (одно ядро, `docs/20-env-and-ports.md`). Два воркера BullMQ с конкурентностью
 * 1 вместе дали бы две, и оба шли бы вдвое медленнее. Кто ждёт — идёт по полосам: сначала проверки контента,
 * потом повторы, внутри полосы — по порядку прихода. Начатое не прерывается: проверка ждёт повтор не дольше
 * `REPLAY_LIMIT_MS`. Затвор передаётся из рук в руки, без окна, в которое мог бы влезть третий.
 */
export class RunGate {
  private busy = false;
  private sequence = 0;
  private readonly waiting: { lane: GateLane; order: number; wake: () => void }[] = [];

  async run<T>(lane: GateLane, task: () => Promise<T>): Promise<T> {
    await this.enter(lane);
    try {
      return await task();
    } finally {
      this.leave();
    }
  }

  private enter(lane: GateLane): Promise<void> {
    if (!this.busy) {
      this.busy = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push({ lane, order: this.sequence++, wake: resolve });
    });
  }

  /** Затвор свободен — или переходит самому важному из ждущих, не становясь свободным. */
  private leave(): void {
    let chosen = 0;
    for (let index = 1; index < this.waiting.length; index += 1) {
      const candidate = this.waiting[index];
      const best = this.waiting[chosen];
      if (candidate === undefined || best === undefined) continue;
      if (GATE_LANES[candidate.lane] < GATE_LANES[best.lane] || (candidate.lane === best.lane && candidate.order < best.order)) chosen = index;
    }
    const [next] = this.waiting.splice(chosen, 1);
    if (next === undefined) this.busy = false;
    else next.wake();
  }
}

export interface ReplayWorkerOptions {
  /** соединение для воркера: `maxRetriesPerRequest: null` — требование BullMQ */
  connection: Redis;
  /** имя очереди; в тестах — своё, чтобы не задеть чужое */
  queueName?: string;
  metrics: Metrics;
  /** затвор, общий с воркером проверок; без него повтор идёт сам по себе — как в тестах */
  gate?: RunGate;
  deps?: ReplayDeps;
}

/**
 * Воркер очереди `replay`. Конкурентность — 1, и она общая с проверкой контента через затвор. Блокировка
 * задания — минута, как у проверок: повтор отдаёт управление циклу событий между частями, и продление
 * блокировки успевает, а пока задание ждёт затвор, продлевает её таймер. Метрики — `sim_jobs_total{queue="replay",outcome}`
 * с вердиктом в исходе и `sim_job_seconds{queue="replay"}` — время повтора без ожидания затвора.
 */
export function createReplayWorker(options: ReplayWorkerOptions): Worker<ReplayJobInput, ReplayResult> {
  const gate = options.gate ?? new RunGate();
  const worker = new Worker<ReplayJobInput, ReplayResult>(
    options.queueName ?? REPLAY_QUEUE,
    (job) =>
      gate.run("replay", async () => {
        const started = performance.now();
        const seconds = (): number => (performance.now() - started) / 1000;
        try {
          const result = await runReplay(job.data, options.deps);
          options.metrics.observe(REPLAY_QUEUE, result.verdict, seconds());
          // Совпавшее — норма и в лог не идёт; остальное — след для разбора с номером забега (в метки он не попадает).
          if (result.verdict !== "match") logEvent("warn", "replay_verdict", { runId: result.runId, verdict: result.verdict, divergedTick: result.divergedTick, durationMs: result.durationMs });
          return result;
        } catch (error: unknown) {
          options.metrics.observe(REPLAY_QUEUE, "error", seconds());
          throw error;
        }
      }),
    { connection: options.connection, concurrency: 1, lockDuration: 60_000 },
  );
  worker.on("failed", (job, error) => logEvent("warn", "replay_failed", { jobId: job?.id ?? null, reason: error.name }));
  // Без обработчика ошибка соединения воркера роняла бы процесс.
  worker.on("error", (error) => logThrottled("warn", "worker_error", { reason: error.message }));
  return worker;
}
