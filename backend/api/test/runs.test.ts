import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { DomainError } from "../src/common/domain-error.js";
import type { RunFinish } from "../src/modules/runs/dto/runs.dto.js";
import { RunsService } from "../src/modules/runs/runs.service.js";
import { RunsViewService } from "../src/modules/runs/runs-view.service.js";
import { RunsHooks, type RecordedRun } from "../src/modules/runs/runs-hooks.js";
import type { AccountRef } from "../src/modules/roles/roles.service.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryLeaderboardStore, MemoryRunsRepository } from "./helpers/memory-runs.js";

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
    service = new RunsService(config(), runs, board, roles, hooks);
    view = new RunsViewService(runs, board);
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
    const fragile = new RunsService(config(), runs, board, roles, hooks);

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

describe("чтение забегов", () => {
  it("лидерборд отмечает свою строку и не выдаёт чужих идентификаторов", async () => {
    const runs = new MemoryRunsRepository();
    const board = new MemoryLeaderboardStore();
    const service = new RunsService(config(), runs, board, new RolesService(config(), new MemoryRolesRepository(), new MemoryAccountRepository()), new RunsHooks());
    const view = new RunsViewService(runs, board);
    const [me, other] = [account("1"), account("2")];
    await service.finish(me, finish(randomUUID(), { survivalSec: 100 }));
    await service.finish(other, finish(randomUUID(), { survivalSec: 200, level: 8, enemiesKilled: 500 }));

    const leaderboard = await view.leaderboardFor(me.accountId, "normal");

    expect(leaderboard.entries.map((entry) => entry.isMe)).toEqual([false, true]);
    expect(leaderboard.me).toEqual({ rank: 2, survivalSec: 100 });
    expect(JSON.stringify(leaderboard)).not.toContain(other.accountId);
  });
});
