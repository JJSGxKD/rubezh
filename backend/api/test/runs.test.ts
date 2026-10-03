import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { DomainError } from "../src/common/domain-error.js";
import { runFinishSchema, type RunFinish } from "../src/modules/runs/dto/runs.dto.js";
import { RunsService } from "../src/modules/runs/runs.service.js";
import { RunsViewService } from "../src/modules/runs/runs-view.service.js";
import { RunContinues, type ContinueLedger } from "../src/modules/runs/run-continues.js";
import { detailsOf, RunExtras, TOP_KILLS_SHOWN } from "../src/modules/runs/run-details.js";
import { RunLoadouts, type LoadoutCheck, type SignedLoadout } from "../src/modules/runs/run-loadouts.js";
import { RunsHooks, type RecordedRun } from "../src/modules/runs/runs-hooks.js";
import type { AccountRef } from "../src/modules/roles/roles.service.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryLeaderboardStore, MemoryRunsRepository, ratingRestrictions } from "./helpers/memory-runs.js";

/**
 * Приём забегов (docs/34-stage3-plan.md, WP4). Проверяется не «забег
 * записался», а то, где приём обычно ломается: повтор итога из очереди,
 * чужой ключ, забег с читами, упавший Redis между базой и рейтингом — и
 * повтор, которым пытаются поднять собственный рекорд.
 */

const ADMIN_TELEGRAM_ID = "777000111";

function config(): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ADMIN_TELEGRAM_IDS: ADMIN_TELEGRAM_ID } as NodeJS.ProcessEnv);
}

function account(platformUserId = "555"): AccountRef {
  return { accountId: randomUUID(), platform: "telegram", platformUserId };
}

function finish(runId: string, patch: Partial<RunFinish> = {}): RunFinish {
  return {
    runId,
    difficultyId: "normal",
    outcome: "died",
    survivalSec: 120,
    level: 6,
    enemiesKilled: 300,
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

describe("приём забегов", () => {
  let runs: MemoryRunsRepository;
  let board: MemoryLeaderboardStore;
  let service: RunsService;
  let view: RunsViewService;
  let recorded: RecordedRun[];

  beforeEach(() => {
    runs = new MemoryRunsRepository();
    board = new MemoryLeaderboardStore();
    const roles = new RolesService(config(), new MemoryRolesRepository(), new MemoryAccountRepository());
    const hooks = new RunsHooks();
    recorded = [];
    hooks.onRecorded("test", async (run) => {
      recorded.push(run);
    });
    service = new RunsService(config(), runs, board, roles, hooks, new RunContinues(), new RunLoadouts(), ratingRestrictions(runs, board).rating);
    view = new RunsViewService(runs, board, new RunExtras(), ratingRestrictions(runs, board).rating);
  });

  it("слушатели узнают о записанном забеге с вердиктом", async () => {
    const me = account();
    const runId = randomUUID();

    await service.finish(me, finish(runId, { survivalSec: 600 }));

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ runId, accountId: me.accountId, survivalSec: 600, ranked: true, verdict: "ok" });
  });

  it("повтор итога слушателей не зовёт: сводка не посчитает забег дважды", async () => {
    const me = account();
    const runId = randomUUID();
    await service.finish(me, finish(runId));

    await service.finish(me, finish(runId));

    expect(recorded).toHaveLength(1);
  });

  it("упавший слушатель не роняет приём забега", async () => {
    const hooks = new RunsHooks();
    hooks.onRecorded("broken", async () => {
      throw new Error("сводка недоступна");
    });
    const roles = new RolesService(config(), new MemoryRolesRepository(), new MemoryAccountRepository());
    const fragile = new RunsService(config(), runs, board, roles, hooks, new RunContinues(), new RunLoadouts(), ratingRestrictions(runs, board).rating);

    await expect(fragile.finish(account(), finish(randomUUID()))).resolves.toMatchObject({ recorded: true });
  });

  it("стартованный и законченный забег попадает в рейтинг с проверенным временем", async () => {
    const me = account();
    const runId = randomUUID();
    await service.start(me, { runId, difficultyId: "normal", startingWeaponId: "knife", contentHash: "abc", elapsedSec: 0 }, 1_000_000);

    const result = await service.finish(me, finish(runId), 1_000_000 + 125_000);

    expect(result).toMatchObject({ recorded: true, verdict: "ok", isNewBest: true, rank: 1, bestSurvivalSec: 120 });
  });

  it("итог без старта принимается: сеть могла потерять старт", async () => {
    const result = await service.finish(account(), finish(randomUUID()));

    expect(result.recorded).toBe(true);
  });

  it("повтор итога из очереди не удваивает ни рейтинг, ни статистику", async () => {
    const me = account();
    const runId = randomUUID();
    await service.finish(me, finish(runId));

    const again = await service.finish(me, finish(runId));

    expect(again).toMatchObject({ recorded: true, isNewBest: false, rank: 1 });
    expect((await view.profile(me.accountId)).runs).toBe(1);
  });

  it("повтор с другим временем не поднимает рекорд: ответ — по записанному", async () => {
    // Сдать малое время, пройти проверки, затем тем же ключом прислать
    // огромное — и ZADD GT поднял бы рекорд, если бы повтор брал тело.
    const me = account();
    const runId = randomUUID();
    await service.finish(me, finish(runId, { survivalSec: 60, level: 4, enemiesKilled: 100 }));

    const forged = await service.finish(me, finish(runId, { survivalSec: 5000 }));

    expect(forged.bestSurvivalSec).toBe(60);
    expect(await board.best("normal", me.accountId)).toBe(60);
  });

  it("чужой ключ забега не принимается", async () => {
    const runId = randomUUID();
    await service.finish(account("1"), finish(runId));

    await expect(service.finish(account("2"), finish(runId))).rejects.toThrow(DomainError);
  });

  it("старт чужим ключом не принимается тоже", async () => {
    const runId = randomUUID();
    const start = { runId, difficultyId: "normal" as const, startingWeaponId: "knife", contentHash: "abc", elapsedSec: 0 };
    await service.start(account("1"), start);

    await expect(service.start(account("2"), start)).rejects.toThrow(DomainError);
  });

  it("повтор старта из очереди — не ошибка", async () => {
    const me = account();
    const start = { runId: randomUUID(), difficultyId: "normal" as const, startingWeaponId: "knife", contentHash: "abc", elapsedSec: 0 };
    await service.start(me, start);

    await expect(service.start(me, start)).resolves.toEqual({ trusted: true });
  });

  it("забег длиннее прошедшего времени записывается, но в рейтинг не идёт", async () => {
    const me = account();
    const runId = randomUUID();
    await service.start(me, { runId, difficultyId: "normal", startingWeaponId: "knife", contentHash: "abc", elapsedSec: 0 }, 1_000_000);

    const result = await service.finish(me, finish(runId, { survivalSec: 600 }), 1_000_000 + 60_000);

    expect(result).toMatchObject({ recorded: false, verdict: "rejected", rank: null });
    expect(await view.review(10)).toHaveLength(1);
  });

  it("забег с читами записывается, но в рейтинг не идёт", async () => {
    const result = await service.finish(account(), finish(randomUUID(), { cheats: true, countInRating: true }));

    expect(result).toMatchObject({ recorded: false, verdict: "ok" });
  });

  it("читы в рейтинг — только по праву tools.dev, а не по флагу клиента", async () => {
    // Ролей в базе нет — работает аварийный путь, и администратор из
    // окружения становится владельцем.
    const admin = account(ADMIN_TELEGRAM_ID);

    const result = await service.finish(admin, finish(randomUUID(), { cheats: true, countInRating: true }));

    expect(result.recorded).toBe(true);
  });

  it("упавший Redis между базой и рейтингом чинится повтором итога", async () => {
    // Забег уже в базе, а рейтинг не записан: клиент получил ошибку и
    // повторит итог. Именно этот повтор и должен дописать место.
    const me = account();
    const runId = randomUUID();
    board.failSubmit = true;
    await expect(service.finish(me, finish(runId))).rejects.toThrow("Redis недоступен");

    board.failSubmit = false;
    const again = await service.finish(me, finish(runId));

    expect(again).toMatchObject({ recorded: true, rank: 1, bestSurvivalSec: 120 });
  });

  it("худший забег не опускает рекорд", async () => {
    const me = account();
    await service.finish(me, finish(randomUUID(), { survivalSec: 300, level: 12, enemiesKilled: 900 }));

    const worse = await service.finish(me, finish(randomUUID(), { survivalSec: 100 }));

    expect(worse).toMatchObject({ isNewBest: false, bestSurvivalSec: 300 });
  });

  it("пересборка возвращает рейтинг к базе после потери Redis", async () => {
    const [first, second] = [account("1"), account("2")];
    await service.finish(first, finish(randomUUID(), { survivalSec: 200, level: 8, enemiesKilled: 500 }));
    await service.finish(second, finish(randomUUID(), { survivalSec: 300, level: 12, enemiesKilled: 900 }));
    await board.replace("normal", []);

    const counts = await service.rebuildLeaderboard();

    expect(counts.normal).toBe(2);
    expect(await board.rank("normal", second.accountId)).toBe(1);
    expect(await board.rank("normal", first.accountId)).toBe(2);
  });
});

describe("второй шанс в итоге забега", () => {
  class FakeLedger implements ContinueLedger {
    paid = 0;
    underpaid = false;
    readonly asked: string[] = [];
    async check(runId: string): Promise<{ paid: number; underpaid: boolean }> {
      this.asked.push(runId);
      return { paid: this.paid, underpaid: this.underpaid };
    }
    async granted(): Promise<number[]> {
      return Array.from({ length: this.paid }, (_, index) => index + 1);
    }
  }

  function setup() {
    const runs = new MemoryRunsRepository();
    const board = new MemoryLeaderboardStore();
    const hooks = new RunsHooks();
    const recorded: RecordedRun[] = [];
    hooks.onRecorded("test", async (run) => void recorded.push(run));
    const continues = new RunContinues();
    const ledger = new FakeLedger();
    continues.provide(ledger);
    const roles = new RolesService(config(), new MemoryRolesRepository(), new MemoryAccountRepository());
    return { service: new RunsService(config(), runs, board, roles, hooks, continues, new RunLoadouts(), ratingRestrictions(runs, board).rating), ledger, recorded, runs, board };
  }

  it("продолжение без покупки — отказ и мимо рейтинга, но забег записан", async () => {
    const { service, recorded, board } = setup();
    const me = account();

    const result = await service.finish(me, finish(randomUUID(), { survivalSec: 600, continues: [250] }));

    expect(result).toMatchObject({ verdict: "rejected", recorded: false });
    expect(recorded[0]).toMatchObject({ continues: 1, reasons: expect.arrayContaining(["unpaid_continue"]) });
    expect(await board.best("normal", me.accountId)).toBeNull();
  });

  it("оплаченное продолжение — обычный забег в рейтинге", async () => {
    const { service, ledger, runs } = setup();
    ledger.paid = 1;
    const runId = randomUUID();

    await expect(service.finish(account(), finish(runId, { survivalSec: 600, continues: [250] }))).resolves.toMatchObject({ verdict: "ok", recorded: true });
    expect(runs.rows.get(runId)?.record?.continues).toEqual([250]);
  });

  it("забег без продолжений за покупками не ходит", async () => {
    const { service, ledger } = setup();

    await service.finish(account(), finish(randomUUID()));

    expect(ledger.asked).toEqual([]);
  });

  it("секунды продолжений вне забега — битые данные, а не вердикт", () => {
    const base = { ...finish(randomUUID(), { survivalSec: 300 }) };

    expect(runFinishSchema.safeParse({ ...base, continues: [301] }).success).toBe(false);
    expect(runFinishSchema.safeParse({ ...base, continues: [200, 100] }).success).toBe(false);
    expect(runFinishSchema.parse({ ...base, continues: undefined }).continues).toEqual([]);
  });
});

describe("снаряжение в итоге забега", () => {
  const snapshot = (accountId: string): SignedLoadout => ({ accountId, modifiers: { damage: 0.1 }, issuedAtMs: 1, signature: "подпись" });

  class FakeCheck implements LoadoutCheck {
    answer: "valid" | "forged" | "stale" = "valid";
    asked: SignedLoadout[] = [];
    async check(_accountId: string, claimed: SignedLoadout): Promise<"valid" | "forged" | "stale"> {
      this.asked.push(claimed);
      return this.answer;
    }
  }

  function setup(checker: LoadoutCheck | null) {
    const runs = new MemoryRunsRepository();
    const board = new MemoryLeaderboardStore();
    const loadouts = new RunLoadouts();
    if (checker !== null) loadouts.provide(checker);
    const roles = new RolesService(config(), new MemoryRolesRepository(), new MemoryAccountRepository());
    return { service: new RunsService(config(), runs, board, roles, new RunsHooks(), new RunContinues(), loadouts, ratingRestrictions(runs, board).rating), board };
  }

  it("подделанный снимок — отказ и мимо рейтинга, устаревший — подозрение", async () => {
    const check = new FakeCheck();
    const { service, board } = setup(check);
    const me = account();

    check.answer = "forged";
    await expect(service.finish(me, finish(randomUUID(), { loadout: snapshot(me.accountId) }))).resolves.toMatchObject({ verdict: "rejected" });
    check.answer = "stale";
    await expect(service.finish(me, finish(randomUUID(), { loadout: snapshot(me.accountId) }))).resolves.toMatchObject({ verdict: "suspicious" });
    expect(await board.best("normal", me.accountId)).toBeNull();

    check.answer = "valid";
    await expect(service.finish(me, finish(randomUUID(), { loadout: snapshot(me.accountId) }))).resolves.toMatchObject({ verdict: "ok", recorded: true });
  });

  it("забег без снимка проверку не зовёт, а без проверки снимку не верят", async () => {
    const check = new FakeCheck();
    const { service } = setup(check);
    await service.finish(account(), finish(randomUUID()));
    expect(check.asked).toEqual([]);

    const unchecked = setup(null).service;
    const me = account();
    await expect(unchecked.finish(me, finish(randomUUID(), { loadout: snapshot(me.accountId) }))).resolves.toMatchObject({ verdict: "rejected" });
  });
});

describe("чтение забегов", () => {
  it("лидерборд отмечает свою строку и не выдаёт чужих идентификаторов", async () => {
    const runs = new MemoryRunsRepository();
    const board = new MemoryLeaderboardStore();
    const service = new RunsService(config(), runs, board, new RolesService(config(), new MemoryRolesRepository(), new MemoryAccountRepository()), new RunsHooks(), new RunContinues(), new RunLoadouts(), ratingRestrictions(runs, board).rating);
    const view = new RunsViewService(runs, board, new RunExtras(), ratingRestrictions(runs, board).rating);
    const [me, other] = [account("1"), account("2")];
    await service.finish(me, finish(randomUUID(), { survivalSec: 100 }));
    await service.finish(other, finish(randomUUID(), { survivalSec: 200, level: 8, enemiesKilled: 500 }));

    const leaderboard = await view.leaderboardFor(me.accountId, "normal");

    expect(leaderboard.entries.map((entry) => entry.isMe)).toEqual([false, true]);
    expect(leaderboard.me).toEqual({ rank: 2, survivalSec: 100 });
    expect(JSON.stringify(leaderboard)).not.toContain(other.accountId);
  });
});

describe("лист забега в профиле", () => {
  function setup() {
    const runs = new MemoryRunsRepository();
    const board = new MemoryLeaderboardStore();
    const extras = new RunExtras();
    const service = new RunsService(config(), runs, board, new RolesService(config(), new MemoryRolesRepository(), new MemoryAccountRepository()), new RunsHooks(), new RunContinues(), new RunLoadouts(), ratingRestrictions(runs, board).rating);
    return { runs, extras, service, view: new RunsViewService(runs, board, extras, ratingRestrictions(runs, board).rating) };
  }

  it("отдаёт свой забег с подробностями, а награду, бусты и добычу — из их модулей", async () => {
    const { extras, service, view } = setup();
    extras.provideReward({ reward: async () => ({ status: "granted", reason: null, coins: 120, xp: 40, levelBefore: 2, levelAfter: 3 }) });
    extras.provideBoosts({ boosts: async () => ["fury"] });
    extras.provideLoot({ loot: async () => [{ slot: "chest", rarity: "rare", level: 2 }] });
    const me = account();
    const runId = randomUUID();
    await service.finish(
      me,
      finish(runId, {
        weapons: [{ id: "knife", level: 3, damage: 4200 }],
        passives: [{ id: "might", level: 2 }],
        stats: { damageTaken: 310, xpCollected: 95, waveReached: 4, topKills: [{ enemy: "swarm_rat", count: 200 }, { enemy: "dasher_wolf", count: 40 }] },
      }),
    );

    const detail = await view.detail(me.accountId, runId);

    expect(detail).toMatchObject({
      runId,
      weapons: [{ id: "knife", level: 3, damage: 4200 }],
      passives: [{ id: "might", level: 2 }],
      damageTaken: 310,
      waveReached: 4,
      deathCause: "swarm_rat",
      rating: "ranked",
      boosts: ["fury"],
      reward: { status: "granted", coins: 120 },
      loot: [{ slot: "chest", rarity: "rare", level: 2 }],
    });
    expect(detail.topKills.map((kill) => kill.enemy)).toEqual(["swarm_rat", "dasher_wolf"]);
  });

  it("чужой и незнакомый забег — run_not_found, а не чужие числа", async () => {
    const { service, view } = setup();
    const [owner, stranger] = [account("1"), account("2")];
    const runId = randomUUID();
    await service.finish(owner, finish(runId));

    for (const [accountId, id] of [[stranger.accountId, runId], [owner.accountId, randomUUID()]] as const) {
      await expect(view.detail(accountId, id)).rejects.toMatchObject({ code: "run_not_found", status: 404 });
    }
  });

  it("сборка без подробностей — лист без них, а не нули; источников нет — частей нет", async () => {
    const { service, view } = setup();
    const me = account();
    const runId = randomUUID();
    await service.finish(me, finish(runId, { outcome: "abandoned", cheats: true }));

    const detail = await view.detail(me.accountId, runId);

    expect(detail).toMatchObject({ passives: [], damageTaken: null, xpCollected: null, waveReached: null, topKills: [], reward: null, boosts: [], loot: [] });
    expect(detail.weapons).toEqual([{ id: "knife", level: 2, damage: null }]);
    // Сдался — смертельного удара не было, даже если клиент прислал врага.
    expect(detail.deathCause).toBeNull();
    expect(detail.rating).toBe("cheats");
  });

  it("профиль отдаёт id забега — по нему открывается лист", async () => {
    const { service, view } = setup();
    const me = account();
    const runId = randomUUID();
    await service.finish(me, finish(runId));
    expect((await view.profile(me.accountId)).recent.map((run) => run.runId)).toEqual([runId]);
  });

  it("кого больше всего убил — по убыванию и не больше пятёрки, даже если клиент прислал иначе", () => {
    const topKills = Array.from({ length: 8 }, (_, index) => ({ enemy: `e${index}`, count: index * 10 }));
    expect(detailsOf({ passives: [], stats: { damageTaken: 0, xpCollected: 0, waveReached: 0, topKills } })?.topKills.map((kill) => kill.count)).toEqual([70, 60, 50, 40, 30]);
    expect(TOP_KILLS_SHOWN).toBe(5);
    expect(detailsOf({ passives: [] })).toBeNull();
  });

  it("итог с подробностями проходит схему, а лишние убийства — нет", () => {
    const base = { ...finish(randomUUID()), passives: undefined };
    expect(runFinishSchema.parse(base).passives).toEqual([]);
    const tooMany = Array.from({ length: 9 }, (_, index) => ({ enemy: `e${index}`, count: 1 }));
    expect(runFinishSchema.safeParse({ ...base, stats: { damageTaken: 1, xpCollected: 1, waveReached: 1, topKills: tooMany } }).success).toBe(false);
  });
});
