import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { RUBEZH_AT_SEC as CONTENT_RUBEZH_AT_SEC, RUBEZH_MIN_FIGHT_SEC as CONTENT_MIN_FIGHT_SEC, RUBEZH_REWARD_MUL as CONTENT_REWARD_MUL } from "../../../packages/shared-types/src/index";
import { loadAppConfig } from "../src/config/app-config.js";
import { EVENT_DICTIONARY } from "../src/modules/events/event-dictionary.js";
import { RUBEZH_REWARD_MUL } from "../src/modules/progress/progress-rules.js";
import { RestrictionsService } from "../src/modules/restrictions/restrictions.service.js";
import type { ImposeInput } from "../src/modules/restrictions/restriction-rules.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { runFinishSchema, type RunFinish } from "../src/modules/runs/dto/runs.dto.js";
import { rebuildLeaderboard } from "../src/modules/runs/leaderboard-rebuild.js";
import { RunContinues } from "../src/modules/runs/run-continues.js";
import { RunExtras } from "../src/modules/runs/run-details.js";
import { RunLoadouts } from "../src/modules/runs/run-loadouts.js";
import { RunPrestige } from "../src/modules/runs/run-prestige.js";
import { RUBEZH_AT_SEC, RUBEZH_MIN_FIGHT_SEC } from "../src/modules/runs/run-verdict.js";
import { RunsHooks, type RecordedRun } from "../src/modules/runs/runs-hooks.js";
import { RunsViewService } from "../src/modules/runs/runs-view.service.js";
import { RunsService } from "../src/modules/runs/runs.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryLeaderboardStore, MemoryRunsRepository, ratingRestrictions } from "./helpers/memory-runs.js";

/**
 * Рубеж на сервере (T-0121, Р102, Р105): форма итога, словарь событий, цифры,
 * общие с движком, и сквозной путь «итог → колонки → набор победителей →
 * флаг в основной доске». Память здесь — те же модули, что в проде; Redis и
 * Postgres проверяются в `runs.integration.test.ts`.
 */

const config = () => loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);

const WIN = { reached: true, clearedSec: 650, guardHpPercent: null };

function finish(patch: Partial<RunFinish> = {}): RunFinish {
  return {
    runId: randomUUID(),
    difficultyId: "hard",
    outcome: "died",
    survivalSec: 700,
    level: 20,
    enemiesKilled: 1500,
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
  const rolesRepository = new MemoryRolesRepository();
  const roles = new RolesService(config(), rolesRepository, accounts);
  const restrictions = new RestrictionsService(rating.restrictions, accounts, roles, rating.gate, rating.hooks);
  const hooks = new RunsHooks();
  const recorded: RecordedRun[] = [];
  hooks.onRecorded("test", async (run) => {
    recorded.push(run);
  });
  const service = new RunsService(config(), runs, board, roles, hooks, new RunContinues(), new RunLoadouts(), rating.rating);
  const view = new RunsViewService(runs, board, new RunExtras(), rating.rating, new RunPrestige());
  return { accounts, runs, board, rating, rolesRepository, restrictions, service, view, recorded };
}

async function player(w: ReturnType<typeof world>, name: string): Promise<AccountRef> {
  const account = await w.accounts.upsert({ platform: "telegram", platformUserId: String(Math.floor(Math.random() * 1e9)), displayName: name, username: null, photoUrl: null }, Date.now());
  return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
}

const separateBoard = (): ImposeInput => ({ kinds: ["separate_board"], endsAt: null, reason: "leaderboard_cheat", comment: null, notify: false });

describe("цифры рубежа: сервер и движок", () => {
  it("отметка прихода стража и минимальный бой совпадают с shared-types", () => {
    // Сервер пакет не импортирует: числа продублированы, равенство держит этот тест.
    expect(RUBEZH_AT_SEC).toBe(CONTENT_RUBEZH_AT_SEC);
    expect(RUBEZH_MIN_FIGHT_SEC).toBe(CONTENT_MIN_FIGHT_SEC);
    expect(RUBEZH_MIN_FIGHT_SEC).toBe(5);
  });

  it("множитель награды — два и совпадает с shared-types", () => {
    expect(RUBEZH_REWARD_MUL).toBe(CONTENT_REWARD_MUL);
    expect(RUBEZH_REWARD_MUL).toBe(2);
  });
});

describe("итог забега с рубежом (DTO)", () => {
  const body = () => ({ ...finish() });

  it("несёт необязательное поле rubezh, старый итог без него проходит", () => {
    expect(runFinishSchema.parse(body()).rubezh).toBeUndefined();
    expect(runFinishSchema.parse({ ...body(), rubezh: WIN }).rubezh).toEqual(WIN);
    expect(runFinishSchema.parse({ ...body(), rubezh: { reached: true, clearedSec: null, guardHpPercent: 40 } }).rubezh).toEqual({ reached: true, clearedSec: null, guardHpPercent: 40 });
    expect(runFinishSchema.parse({ ...body(), rubezh: { reached: false, clearedSec: null, guardHpPercent: null } }).rubezh?.reached).toBe(false);
  });

  it("секунда победы — от 0 до суток, целая; процент — от 0 до 100", () => {
    const parse = (rubezh: unknown) => runFinishSchema.safeParse({ ...body(), rubezh }).success;
    expect(parse({ reached: true, clearedSec: 0, guardHpPercent: null })).toBe(true);
    expect(parse({ reached: true, clearedSec: 86_400, guardHpPercent: null })).toBe(true);
    expect(parse({ reached: true, clearedSec: -1, guardHpPercent: null })).toBe(false);
    expect(parse({ reached: true, clearedSec: 86_401, guardHpPercent: null })).toBe(false);
    expect(parse({ reached: true, clearedSec: 650.5, guardHpPercent: null })).toBe(false);
    expect(parse({ reached: true, clearedSec: null, guardHpPercent: 0 })).toBe(true);
    expect(parse({ reached: true, clearedSec: null, guardHpPercent: 100 })).toBe(true);
    expect(parse({ reached: true, clearedSec: null, guardHpPercent: 101 })).toBe(false);
    expect(parse({ reached: true, clearedSec: null, guardHpPercent: -1 })).toBe(false);
    expect(parse({ reached: "yes", clearedSec: null, guardHpPercent: null })).toBe(false);
  });
});

describe("словарь событий: рубеж в итоге забега", () => {
  const base = { seed: 1, survivalSec: 700, level: 20, wave: 9, enemiesKilled: 1500, weapon: "knife", map: "field", difficulty: "hard", contentHash: "abc", isNewRecord: false, cheats: false };

  it.each(["run_finished", "run_abandoned"] as const)("%s: rubezh и секунда победы проходят схему, значение вне списка — нет, старый payload проходит", (name) => {
    const { payload } = EVENT_DICTIONARY[name];
    expect(payload.safeParse(base).success).toBe(true);
    expect(payload.safeParse({ ...base, rubezh: "cleared", rubezhClearedSec: 650 }).success).toBe(true);
    expect(payload.safeParse({ ...base, rubezh: "reached" }).success).toBe(true);
    expect(payload.safeParse({ ...base, rubezh: "none" }).success).toBe(true);
    expect(payload.safeParse({ ...base, rubezh: "won" }).success).toBe(false);
    expect(payload.safeParse({ ...base, rubezh: "cleared", rubezhClearedSec: -1 }).success).toBe(false);
    expect(payload.safeParse({ ...base, rubezh: "cleared", rubezhClearedSec: 650.5 }).success).toBe(false);
  });

  it("версия событий остаётся первой", () => {
    expect(EVENT_DICTIONARY.run_finished.version).toBe(1);
    expect(EVENT_DICTIONARY.run_abandoned.version).toBe(1);
  });
});

describe("победа над стражем в приёме забегов", () => {
  let w: ReturnType<typeof world>;

  beforeEach(() => {
    w = world();
  });

  it("засчитанная победа пишет колонки и ставит флаг в основной доске", async () => {
    const me = await player(w, "Победитель");
    const runId = randomUUID();

    await w.service.finish(me, finish({ runId, rubezh: WIN }));

    expect(w.runs.rows.get(runId)?.record).toMatchObject({ verdict: "ok", ranked: true, rubezhReached: true, rubezhClearedSec: 650 });
    const board = await w.view.leaderboardFor(me.accountId, "hard");
    expect(board.entries[0]).toMatchObject({ isMe: true, rubezh: true });
    expect(w.recorded[0]).toMatchObject({ runId, rubezhCleared: true });
  });

  it("забег без победы и без поля rubezh набор не трогает: флага нет, поля в строке тоже", async () => {
    const [plain, reached] = [await player(w, "Обычный"), await player(w, "Дошёл")];

    await w.service.finish(plain, finish());
    await w.service.finish(reached, finish({ rubezh: { reached: true, clearedSec: null, guardHpPercent: 35 } }));

    const board = await w.view.leaderboardFor(plain.accountId, "hard");
    expect(board.entries).toHaveLength(2);
    for (const entry of board.entries) expect(entry).not.toHaveProperty("rubezh");
    expect(w.runs.rows.get(w.recorded[1]?.runId ?? "")?.record).toMatchObject({ rubezhReached: true, rubezhClearedSec: null });
    expect(w.recorded[1]?.rubezhCleared).toBe(false);
  });

  it.each([
    ["победа раньше, чем страж мог пасть", { reached: true, clearedSec: 599, guardHpPercent: null }, 700],
    ["победа позже конца забега", { reached: true, clearedSec: 702, guardHpPercent: null }, 700],
    ["победа при reached: false", { reached: false, clearedSec: 650, guardHpPercent: null }, 700],
  ])("%s: подозрение, забег сохранён, в рейтинге и с флагом его нет", async (_name, rubezh, survivalSec) => {
    const me = await player(w, "Подозрительный");
    const runId = randomUUID();

    const result = await w.service.finish(me, finish({ runId, survivalSec, rubezh }));

    expect(result).toMatchObject({ recorded: false, verdict: "suspicious" });
    expect(w.runs.rows.get(runId)?.record).toMatchObject({ verdict: "suspicious", ranked: false, rubezhClearedSec: rubezh.clearedSec });
    expect(w.runs.rows.get(runId)?.record?.verdictReasons).toContain("rubezh_implausible");
    expect((await w.view.leaderboardFor(me.accountId, "hard")).entries).toEqual([]);
  });

  it("повтор итога победы ничего не меняет, а упавший Redis чинится повтором вместе с флагом", async () => {
    const me = await player(w, "Повтор");
    const runId = randomUUID();
    w.board.failSubmit = true;
    await expect(w.service.finish(me, finish({ runId, rubezh: WIN }))).rejects.toThrow("Redis недоступен");

    w.board.failSubmit = false;
    const recordedBefore = w.recorded.length;
    // Повтор приходит с другим телом: победу берём из записанного забега, а не из повтора.
    await w.service.finish(me, finish({ runId, rubezh: undefined }));
    await w.service.finish(me, finish({ runId, rubezh: WIN }));

    expect((await w.view.leaderboardFor(me.accountId, "hard")).entries[0]).toMatchObject({ rubezh: true });
    // Повтор слушателей не зовёт: награда второй раз не уходит.
    expect(w.recorded).toHaveLength(recordedBefore);
  });

  it("победа в нерейтинговой сложности отметку не ставит", async () => {
    const me = await player(w, "Лёгкая");

    await w.service.finish(me, finish({ difficultyId: "easy", rubezh: WIN }));

    expect((await w.view.leaderboardFor(me.accountId, "easy")).entries).toEqual([]);
    expect((await w.board.top("hard", 10, "full")).some((entry) => entry.rubezh)).toBe(false);
    expect((await w.board.top("easy", 10, "full")).some((entry) => entry.rubezh)).toBe(false);
  });

  it("забег с читами победу не засчитывает", async () => {
    const me = await player(w, "Читер");

    await w.service.finish(me, finish({ cheats: true, rubezh: WIN }));

    expect((await w.view.leaderboardFor(me.accountId, "hard")).entries).toEqual([]);
  });

  describe("рейтинговый забег с читами и победой (владелец считает читы в рейтинге)", () => {
    async function cheatingWinner(): Promise<{ owner: AccountRef; runId: string }> {
      const owner = await player(w, "Владелец с читами");
      await w.rolesRepository.grant(owner.accountId, "owner", null);
      const runId = randomUUID();
      await w.service.finish(owner, finish({ runId, cheats: true, countInRating: true, rubezh: WIN }));
      return { owner, runId };
    }

    it("забег попал в рейтинг, а отметки победителя нет", async () => {
      const { owner, runId } = await cheatingWinner();

      expect(w.runs.rows.get(runId)?.record).toMatchObject({ verdict: "ok", ranked: true, cheats: true, rubezhReached: true, rubezhClearedSec: 650 });
      const entries = (await w.view.leaderboardFor(owner.accountId, "hard")).entries;
      expect(entries).toHaveLength(1);
      expect(entries[0]).not.toHaveProperty("rubezh");
      expect(await w.runs.rubezhWinners("hard", null)).toEqual([]);
    });

    it("пересборка доски отметку не ставит", async () => {
      await cheatingWinner();
      const lost = new MemoryLeaderboardStore();

      await rebuildLeaderboard(w.runs, lost, new Set(), new Set(), null);

      const top = await lost.top("hard", 10, "full");
      expect(top).toHaveLength(1);
      expect(top.some((entry) => entry.rubezh)).toBe(false);
    });

    it("снятие другого забега модератором отметку не ставит", async () => {
      const { owner } = await cheatingWinner();
      const otherRunId = randomUUID();
      await w.service.finish(owner, finish({ runId: otherRunId, cheats: false, survivalSec: 640 }));

      await w.service.setRanked(owner, otherRunId, false, "проверка");

      const top = await w.board.top("hard", 10, "full");
      expect(top).toHaveLength(1);
      expect(top.some((entry) => entry.rubezh)).toBe(false);
    });

    it("честная победа того же аккаунта отметку ставит, и снятие забега с читами её не убирает", async () => {
      const { owner, runId } = await cheatingWinner();
      await w.service.finish(owner, finish({ cheats: false, survivalSec: 660, rubezh: { reached: true, clearedSec: 620, guardHpPercent: null } }));
      expect((await w.board.top("hard", 10, "full")).some((entry) => entry.rubezh)).toBe(true);

      await w.service.setRanked(owner, runId, false, "проверка");

      expect((await w.board.top("hard", 10, "full")).some((entry) => entry.rubezh)).toBe(true);
    });
  });

  it("победа скрытого аккаунта другим не видна; тот, кому положена полная доска, видит её флаг", async () => {
    const owner = await player(w, "Владелец");
    await w.rolesRepository.grant(owner.accountId, "owner", null);
    const [hidden, plain, watcher] = [await player(w, "Скрытый"), await player(w, "Обычный"), await player(w, "Тоже скрытый")];
    await w.restrictions.impose(owner, hidden.accountId, separateBoard());
    await w.restrictions.impose(owner, watcher.accountId, separateBoard());
    await w.service.finish(hidden, finish({ survivalSec: 800, rubezh: { reached: true, clearedSec: 700, guardHpPercent: null } }));
    await w.service.finish(plain, finish({ survivalSec: 650, rubezh: { reached: true, clearedSec: 620, guardHpPercent: null } }));
    await w.service.finish(watcher, finish({ survivalSec: 640 }));

    const common = await w.view.leaderboardFor(plain.accountId, "hard");
    expect(common.entries.map((entry) => [entry.survivalSec, entry.rubezh === true])).toEqual([[650, true]]);

    const full = await w.view.leaderboardFor(watcher.accountId, "hard");
    expect(full.entries.map((entry) => [entry.survivalSec, entry.rubezh === true])).toEqual([
      [800, true],
      [650, true],
      [640, false],
    ]);
  });

  it("пересборка доски восстанавливает набор по базе: победа засчитана, вердикт ok, забег шёл в рейтинг", async () => {
    const [winner, suspicious, loser] = [await player(w, "Победитель"), await player(w, "Сомнительный"), await player(w, "Без победы")];
    await w.service.finish(winner, finish({ rubezh: WIN }));
    await w.service.finish(suspicious, finish({ rubezh: { reached: false, clearedSec: 650, guardHpPercent: null } }));
    await w.service.finish(loser, finish());
    // Redis потерян целиком, рейтинг строится заново.
    const lost = new MemoryLeaderboardStore();

    await rebuildLeaderboard(w.runs, lost, new Set(), new Set(), null);

    const top = await lost.top("hard", 10, "common");
    expect(top.filter((entry) => entry.rubezh).map((entry) => entry.accountId)).toEqual([winner.accountId]);
    expect(top).toHaveLength(2);
  });

  it("пересборка убирает из набора победителя, чей забег перестал быть рейтинговым", async () => {
    const me = await player(w, "Снятый");
    const runId = randomUUID();
    await w.service.finish(me, finish({ runId, rubezh: WIN }));
    const owner = await player(w, "Модератор");
    await w.rolesRepository.grant(owner.accountId, "owner", null);
    await w.service.setRanked(owner, runId, false, "проверка");

    await rebuildLeaderboard(w.runs, w.board, new Set(), new Set(), null);

    expect((await w.board.top("hard", 10, "full")).some((entry) => entry.rubezh)).toBe(false);
  });
});
