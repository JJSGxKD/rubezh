import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT_UNLOCKS } from "../../../packages/core-game/src/content/unlocks";
import { RUN_MODIFIER_IDS as CONTENT_MODIFIER_IDS } from "../../../packages/shared-types/src/index";
import { loadAppConfig } from "../src/config/app-config.js";
import { EVENT_DICTIONARY } from "../src/modules/events/event-dictionary.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { runFinishSchema, runStartSchema, type RunFinish, type RunStart } from "../src/modules/runs/dto/runs.dto.js";
import { RunContinues } from "../src/modules/runs/run-continues.js";
import { RunExtras } from "../src/modules/runs/run-details.js";
import { RunLoadouts } from "../src/modules/runs/run-loadouts.js";
import { RunPrestige } from "../src/modules/runs/run-prestige.js";
import { MODIFIER_UNLOCK_LEVEL, RUN_MODIFIER_IDS } from "../src/modules/runs/run-verdict.js";
import { RunsHooks, type RecordedRun } from "../src/modules/runs/runs-hooks.js";
import { RunsViewService } from "../src/modules/runs/runs-view.service.js";
import { RunsService } from "../src/modules/runs/runs.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryLeaderboardStore, MemoryRunsRepository, ratingRestrictions, survivalScorer } from "./helpers/memory-runs.js";

/**
 * Модификаторы забега на сервере (T-0122, Р105, `docs/39-retention-mechanics.md` Б8):
 * форма сообщений, общие с движком таблицы, словарь событий и приём забега —
 * вердикт, рейтинг и то, что уходит слушателям награды. Деньги считает
 * `progress.test.ts`, Postgres и Redis — `runs.integration.test.ts` и
 * `progress.integration.test.ts`.
 */

const config = () => loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, RUNS_MAX_KILLS_PER_SEC: "10", RUNS_MAX_LEVELS_PER_MIN: "5" } as NodeJS.ProcessEnv);

const START_MS = 1_000_000;
const FINISH_MS = START_MS + 310_000;

function startBody(patch: Partial<RunStart> = {}): RunStart {
  return { runId: randomUUID(), difficultyId: "hard", startingWeaponId: "knife", contentHash: "abc", elapsedSec: 0, ...patch };
}

function finish(patch: Partial<RunFinish> = {}): RunFinish {
  return {
    runId: randomUUID(),
    difficultyId: "hard",
    outcome: "died",
    survivalSec: 300,
    level: 10,
    enemiesKilled: 1000,
    startingWeaponId: "knife",
    weapons: [{ id: "knife", level: 2 }],
    contentHash: "abc",
    deathCause: "swarm_rat",
    cheats: false,
    countInRating: false,
    continues: [],
    boosts: [],
    passives: [],
    ...patch,
  };
}

function world() {
  const accounts = new MemoryAccountRepository();
  const runs = new MemoryRunsRepository();
  const board = new MemoryLeaderboardStore();
  const rating = ratingRestrictions(runs, board);
  const roles = new RolesService(config(), new MemoryRolesRepository(), accounts);
  const hooks = new RunsHooks();
  const recorded: RecordedRun[] = [];
  hooks.onRecorded("test", async (run) => {
    recorded.push(run);
  });
  const loadouts = new RunLoadouts();
  const service = new RunsService(config(), runs, board, roles, hooks, new RunContinues(), loadouts, rating.rating, undefined, survivalScorer());
  const view = new RunsViewService(runs, board, new RunExtras(), rating.rating, new RunPrestige());
  return { accounts, runs, board, service, view, recorded, loadouts };
}

type World = ReturnType<typeof world>;
type Modifiers = NonNullable<RunStart["modifierIds"]>;

/** Игрок с заданным уровнем на сервере: по нему открываются модификаторы. */
async function player(w: World, level: number): Promise<AccountRef> {
  const created = await w.accounts.upsert({ platform: "telegram", platformUserId: String(Math.floor(Math.random() * 1e9)), displayName: "Игрок", username: null, photoUrl: null }, Date.now());
  w.runs.levels.set(created.accountId, level);
  return { accountId: created.accountId, platform: created.platform, platformUserId: created.platformUserId };
}

describe("форма модификаторов в старте и итоге забега", () => {
  it.each([
    ["старт", (modifierIds?: unknown) => runStartSchema.safeParse({ ...startBody(), ...(modifierIds === undefined ? {} : { modifierIds }) })],
    ["итог", (modifierIds?: unknown) => runFinishSchema.safeParse({ ...finish(), ...(modifierIds === undefined ? {} : { modifierIds }) })],
  ] as const)("%s: пустой список и один известный id проходят, поля нет — забег без модификатора", (_name, parse) => {
    expect(parse().success).toBe(true);
    expect(parse([]).success).toBe(true);
    expect(parse(["hurry"]).success).toBe(true);
    expect(parse(["inverse"]).success).toBe(true);
    const absent = parse();
    expect(absent.success && (absent.data.modifierIds ?? [])).toEqual([]);
  });

  it.each([
    ["старт", (modifierIds: unknown) => runStartSchema.safeParse({ ...startBody(), modifierIds })],
    ["итог", (modifierIds: unknown) => runFinishSchema.safeParse({ ...finish(), modifierIds })],
  ] as const)("%s: неизвестный id, два модификатора, повтор и не-массив — ошибка формы", (_name, parse) => {
    expect(parse(["fast"]).success).toBe(false);
    expect(parse(["hurry", "inverse"]).success).toBe(false);
    expect(parse(["hurry", "hurry"]).success).toBe(false);
    expect(parse("hurry").success).toBe(false);
    expect(parse([1]).success).toBe(false);
    expect(parse([null]).success).toBe(false);
  });
});

describe("таблицы модификаторов: сервер и движок", () => {
  it("список id совпадает с shared-types", () => {
    // Сервер пакет не импортирует: список продублирован, равенство держит этот тест.
    expect([...RUN_MODIFIER_IDS]).toEqual([...CONTENT_MODIFIER_IDS]);
  });

  it("уровни открытия совпадают с лестницей открытий контента", () => {
    const content: Record<string, number> = {};
    for (const row of ACCOUNT_UNLOCKS) for (const id of row.modifiers ?? []) content[id] = row.level;
    expect(MODIFIER_UNLOCK_LEVEL, "поправьте MODIFIER_UNLOCK_LEVEL в backend/api/src/modules/runs/run-verdict.ts").toEqual(content);
  });
});

describe("словарь событий: модификатор забега", () => {
  const started = { seed: 1, weapon: "knife", map: "field", difficulty: "hard", screenMode: "fullscreen", orientation: "portrait", devMode: false };
  const outcome = { seed: 1, survivalSec: 700, level: 20, wave: 9, enemiesKilled: 1500, weapon: "knife", map: "field", difficulty: "hard", contentHash: "abc", isNewRecord: false, cheats: false };

  it("run_started: modifier из списка проходит, значение вне списка — нет, старый payload проходит", () => {
    const { payload } = EVENT_DICTIONARY.run_started;
    expect(payload.safeParse(started).success).toBe(true);
    // Список словаря — копия `RUN_MODIFIER_IDS`: добавили модификатор и забыли словарь — событие не пройдёт.
    for (const id of RUN_MODIFIER_IDS) expect(payload.safeParse({ ...started, modifier: id }).success, `модификатора ${id} нет в словаре событий`).toBe(true);
    expect(payload.safeParse({ ...started, modifier: "fast" }).success).toBe(false);
    expect(payload.safeParse({ ...started, modifier: "" }).success).toBe(false);
  });

  it.each(["run_finished", "run_abandoned"] as const)("%s: то же поле, версия событий остаётся первой", (name) => {
    const { payload, version } = EVENT_DICTIONARY[name];
    expect(version).toBe(1);
    expect(payload.safeParse(outcome).success).toBe(true);
    expect(payload.safeParse({ ...outcome, modifier: "inverse" }).success).toBe(true);
    expect(payload.safeParse({ ...outcome, modifier: "fast" }).success).toBe(false);
  });

  it("run_started: версия остаётся первой", () => {
    expect(EVENT_DICTIONARY.run_started.version).toBe(1);
  });
});

describe("приём забега с модификатором", () => {
  let w: World;

  beforeEach(() => {
    w = world();
  });

  /** Забег игрока заданного уровня: `started` — что назвал старт (`null` — старт не дошёл), `finished` — что назвал итог (нет поля — сборка без модификаторов). */
  async function played(level: number, started: Modifiers | null, finished: Modifiers | undefined, patch: Partial<RunFinish> = {}) {
    const me = await player(w, level);
    const runId = randomUUID();
    if (started !== null) await w.service.start(me, startBody({ runId, modifierIds: started }), START_MS);
    const result = await w.service.finish(me, finish({ runId, ...(finished === undefined ? {} : { modifierIds: finished }), ...patch }), FINISH_MS);
    return { me, runId, result, stored: w.runs.rows.get(runId) };
  }

  it("честный забег на открытом модификаторе: вердикт ok, модификатор записан, слушатели награды его видят", async () => {
    const { runId, result, stored } = await played(9, ["hurry"], ["hurry"]);

    expect(result.verdict).toBe("ok");
    expect(stored?.record).toMatchObject({ verdict: "ok", verdictReasons: [], modifierId: "hurry" });
    expect(w.recorded).toHaveLength(1);
    expect(w.recorded[0]).toMatchObject({ runId, verdict: "ok", modifierId: "hurry", cheats: false });
  });

  it("забег с модификатором не идёт в рейтинг: ни места, ни рекорда, доска пуста", async () => {
    const { me, result, stored } = await played(12, ["inverse"], ["inverse"]);

    expect(result).toMatchObject({ recorded: false, verdict: "ok", isNewBest: false, rank: null, bestSurvivalSec: 0 });
    expect(stored?.record?.ranked).toBe(false);
    expect((await w.view.leaderboardFor(me.accountId, "hard")).entries).toEqual([]);
    expect(w.recorded[0]).toMatchObject({ ranked: false });
  });

  it("забег с модификатором не двигает личный рекорд сложности", async () => {
    const me = await player(w, 12);
    await w.service.finish(me, finish({ survivalSec: 120, level: 6, enemiesKilled: 300 }), FINISH_MS);
    const before = await w.view.leaderboardFor(me.accountId, "hard");
    expect(before.entries).toHaveLength(1);

    const runId = randomUUID();
    await w.service.start(me, startBody({ runId, modifierIds: ["hurry"] }), START_MS);
    const result = await w.service.finish(me, finish({ runId, modifierIds: ["hurry"], survivalSec: 300, level: 12, enemiesKilled: 1200 }), FINISH_MS);

    // Лучшее осталось от обычного забега: 120 секунд, а не 300.
    expect(result).toMatchObject({ recorded: false, isNewBest: false, bestSurvivalSec: 120, rank: 1 });
    const after = await w.view.leaderboardFor(me.accountId, "hard");
    expect(after.entries).toEqual(before.entries);
  });

  it("обычный забег того же игрока по-прежнему идёт в рейтинг", async () => {
    const { result, stored } = await played(12, null, undefined);

    expect(result).toMatchObject({ recorded: true, verdict: "ok", isNewBest: true, rank: 1 });
    expect(stored?.record).toMatchObject({ ranked: true, modifierId: null });
    expect(w.recorded[0]?.modifierId ?? null).toBeNull();
  });

  it("забег с модификатором считается обычным для награды и заданий: вердикт ok, счётчики и ключи те же", async () => {
    const { runId } = await played(12, ["inverse"], ["inverse"]);

    expect(w.recorded[0]).toMatchObject({ runId, verdict: "ok", reasons: [], cheats: false, modifierId: "inverse" });
    expect(w.recorded[0]?.counters).toBeNull();
    expect(w.recorded[0]?.survivalSec).toBe(300);
  });

  it("закрытый модификатор (уровень 8): отказ, награды нет, в рейтинг не идёт", async () => {
    const { result, stored } = await played(8, ["hurry"], ["hurry"]);

    expect(result).toMatchObject({ recorded: false, verdict: "rejected" });
    expect(stored?.record).toMatchObject({ verdict: "rejected", ranked: false, modifierId: "hurry" });
    expect(stored?.record?.verdictReasons).toContain("modifier_locked");
    expect(w.recorded[0]).toMatchObject({ verdict: "rejected", modifierId: "hurry" });
  });

  it("«Инверсия» открыта с 12-го уровня: на 11-м закрыта, «Спешка» на 11-м открыта", async () => {
    const locked = await played(11, ["inverse"], ["inverse"]);
    const open = await played(11, ["hurry"], ["hurry"]);

    expect(locked.stored?.record?.verdictReasons).toContain("modifier_locked");
    expect(open.stored?.record?.verdictReasons).not.toContain("modifier_locked");
    expect(open.stored?.record?.verdict).toBe("ok");
  });

  it("уровень берётся с сервера: «accountLevel» в подписанном снимке уровня не подменяет", async () => {
    const me = await player(w, 8);
    w.loadouts.provide({ check: async () => "valid" });
    const runId = randomUUID();

    await w.service.finish(
      me,
      finish({
        runId,
        modifierIds: ["hurry"],
        loadout: { accountId: me.accountId, modifiers: {}, accountLevel: 50, issuedAtMs: START_MS, signature: "sig" },
      }),
      FINISH_MS,
    );

    const record = w.runs.rows.get(runId)?.record;
    expect(record?.verdict).toBe("rejected");
    expect(record?.verdictReasons).toContain("modifier_locked");
  });

  it("старт «Спешка», итог «Инверсия»: подозрение, множителя не будет, в рейтинг не идёт", async () => {
    const { result, stored } = await played(12, ["hurry"], ["inverse"]);

    expect(result).toMatchObject({ recorded: false, verdict: "suspicious" });
    expect(stored?.record?.verdictReasons).toEqual(["modifier_mismatch"]);
    expect(stored?.record).toMatchObject({ ranked: false });
    expect(w.recorded[0]).toMatchObject({ verdict: "suspicious", ranked: false });
  });

  it("старт с модификатором, итог без него — тоже расхождение, и забег не идёт в рейтинг", async () => {
    const { result, stored } = await played(12, ["hurry"], undefined);

    expect(result).toMatchObject({ recorded: false, verdict: "suspicious" });
    expect(stored?.record?.verdictReasons).toContain("modifier_mismatch");
  });

  it("старт без модификатора, итог с ним: расхождение, а не бесплатный множитель", async () => {
    const { result, stored } = await played(12, [], ["hurry"]);

    expect(result.verdict).toBe("suspicious");
    expect(stored?.record?.verdictReasons).toContain("modifier_mismatch");
  });

  it("старт не дошёл: итог с модификатором не портит вердикт, но и в рейтинг не идёт", async () => {
    const { result, stored } = await played(12, null, ["hurry"]);

    expect(result).toMatchObject({ recorded: false, verdict: "ok" });
    expect(stored?.record?.verdictReasons).toEqual(["unverified_time"]);
    expect(stored?.record).toMatchObject({ ranked: false, modifierId: "hurry" });
  });

  it("честная «Спешка» с повышенными убийствами и уровнями остаётся ok, а такой же забег без модификатора — подозрение", async () => {
    // Пределы теста: 10 убийств в секунду и 5 уровней в минуту; на «Спешке» — 15 и 8.
    const heavy = { enemiesKilled: 4_000, level: 35 };
    const withModifier = await played(12, ["hurry"], ["hurry"], heavy);
    const without = await played(12, null, undefined, heavy);

    expect(withModifier.stored?.record).toMatchObject({ verdict: "ok", verdictReasons: [] });
    expect(without.stored?.record).toMatchObject({ verdict: "suspicious" });
    expect(without.stored?.record?.verdictReasons).toEqual(expect.arrayContaining(["kill_rate", "level_rate"]));
  });

  it("«Спешка» всё же ловится за своим пределом, а «Инверсия» — за прежним по убийствам", async () => {
    const hurry = await played(12, ["hurry"], ["hurry"], { enemiesKilled: 4_600 });
    const inverse = await played(12, ["inverse"], ["inverse"], { enemiesKilled: 3_100 });

    expect(hurry.stored?.record?.verdictReasons).toContain("kill_rate");
    expect(inverse.stored?.record?.verdictReasons).toContain("kill_rate");
  });

  it("читы: забег с модификатором и читами не получает ничего — слушатель видит читы, а не модификатор без читов", async () => {
    const { stored } = await played(12, ["hurry"], ["hurry"], { cheats: true });

    expect(stored?.record).toMatchObject({ cheats: true, ranked: false });
    expect(w.recorded[0]).toMatchObject({ cheats: true, modifierId: "hurry" });
  });

  it("повтор итога с другим модификатором: ответ и запись — по записанному забегу", async () => {
    const me = await player(w, 12);
    const runId = randomUUID();
    await w.service.start(me, startBody({ runId, modifierIds: ["hurry"] }), START_MS);
    await w.service.finish(me, finish({ runId, modifierIds: ["hurry"] }), FINISH_MS);

    // Повтор без модификатора пытается «обнулить» запись и вернуться в рейтинг.
    const again = await w.service.finish(me, finish({ runId }), FINISH_MS + 1_000);

    expect(again).toMatchObject({ recorded: false, rank: null });
    expect(w.runs.rows.get(runId)?.record).toMatchObject({ modifierId: "hurry", ranked: false });
    expect(w.recorded).toHaveLength(1);
  });

  it("поле не пришло вовсе (сборка до модификаторов): забег без модификатора, как раньше", async () => {
    const { result, stored } = await played(1, [], undefined);

    expect(result).toMatchObject({ recorded: true, verdict: "ok" });
    expect(stored?.record).toMatchObject({ verdict: "ok", ranked: true, modifierId: null });
  });

  it("пустой список в итоге — тот же забег без модификатора", async () => {
    const { result, stored } = await played(1, null, []);

    expect(result.recorded).toBe(true);
    expect(stored?.record?.modifierId).toBeNull();
  });
});
