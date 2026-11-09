import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createHttpApp } from "../src/http-app.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { DailyService } from "../src/modules/daily/daily.service.js";
import { PrismaDailyRepository } from "../src/modules/daily/daily.repository.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import type { ProgressService } from "../src/modules/progress/progress.service.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import type { RunFinish } from "../src/modules/runs/dto/runs.dto.js";
import { PrologueService, PrismaPrologueStore } from "../src/modules/runs/prologue.service.js";
import { RunContinues } from "../src/modules/runs/run-continues.js";
import { RunExtras } from "../src/modules/runs/run-details.js";
import { RunLoadouts } from "../src/modules/runs/run-loadouts.js";
import { RunPrestige } from "../src/modules/runs/run-prestige.js";
import { RunProofsService } from "../src/modules/runs/run-proofs.service.js";
import { RunsController } from "../src/modules/runs/runs.controller.js";
import { RunsHooks, type RecordedRun } from "../src/modules/runs/runs-hooks.js";
import { PrismaRunsRepository } from "../src/modules/runs/runs.repository.js";
import { RunsService } from "../src/modules/runs/runs.service.js";
import { RunsViewService, type ProfileView } from "../src/modules/runs/runs-view.service.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { countsForTasks } from "../src/modules/tasks/task-rules.js";
import { TaskNotFoundError } from "../src/modules/tasks/tasks-errors.js";
import { PrismaTasksRepository } from "../src/modules/tasks/tasks.repository.js";
import { TasksService } from "../src/modules/tasks/tasks.service.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryLeaderboardStore, ratingRestrictions } from "./helpers/memory-runs.js";
import { panelSettings } from "./helpers/settings.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Пролог на живом Postgres (tasks/T-0279, Р151; docs/17-testing-strategy.md
 * §4.2; адрес — TEST_DATABASE_URL, без него пропуск): запись забега-пролога,
 * награда ровно один раз, признак «пролог пройден» и закрытые разделы.
 *
 * Память этого не покажет: признак ставит тот же запрос, что записывает
 * забег, а один раз награда выдаётся ключом кошелька под гонкой двух
 * запросов. Тест смотрит только на свои аккаунты.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const NOON = new Date("2026-11-03T09:00:00.000Z");

/** Запись откатывается: миграционный запрос трогает все аккаунты общей базы. */
class Rollback extends Error {}

function migrationStatements(): string[] {
  const directory = fileURLToPath(new URL("../prisma/migrations/", import.meta.url));
  const names = readdirSync(directory).filter((name) => name.endsWith("_prologue"));
  if (names.length !== 1) throw new Error(`миграция prologue должна быть одна, найдено: ${String(names.length)}`);
  const sql = readFileSync(`${directory}${names[0] ?? ""}/migration.sql`, "utf8");
  const code = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  return code
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
}

describe.skipIf(DATABASE_URL === "")("пролог на живом Postgres", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let wallet: WalletService;
  let prologue: PrologueService;
  let runs: PrismaRunsRepository;
  let board: MemoryLeaderboardStore;
  let service: RunsService;
  let view: RunsViewService;
  let daily: DailyService;
  let tasks: TasksService;
  let recorded: RecordedRun[];
  let app: NestFastifyApplication | null = null;

  async function person(): Promise<AccountRef> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(790_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Новичок", username: null },
      Date.now(),
    );
    return { accountId: created.accountId, platform: "telegram", platformUserId: created.platformUserId };
  }

  /** Тело итога пролога: победа над Стражем на 170-й секунде, если не сказано иное. */
  function prologueBody(runId: string, patch: Partial<RunFinish> = {}): RunFinish {
    return {
      runId,
      difficultyId: "easy",
      mode: "prologue",
      outcome: "abandoned",
      survivalSec: 170,
      level: 8,
      enemiesKilled: 160,
      startingWeaponId: "knife",
      weapons: [{ id: "knife", level: 2 }],
      contentHash: "abc",
      deathCause: null,
      cheats: false,
      countInRating: false,
      continues: [],
      boosts: [],
      passives: [],
      prologue: { won: true, sec: 170 },
      ...patch,
    };
  }

  async function balances(accountId: string): Promise<{ coins: number; gems: number }> {
    const all = await wallet.balances(accountId);
    return { coins: all.coins, gems: all.gems };
  }

  async function prologueEntries(accountId: string): Promise<{ resource: string; amount: number }[]> {
    return await prisma.$queryRaw<{ resource: string; amount: number }[]>`
      SELECT resource::text AS resource, amount::int AS amount FROM wallet_entry
      WHERE account_id = ${accountId}::uuid AND reason = 'prologue_reward' ORDER BY resource`;
  }

  async function doneAt(accountId: string): Promise<Date | null> {
    const [row] = await prisma.$queryRaw<{ done: Date | null }[]>`SELECT prologue_done_at AS done FROM account WHERE account_id = ${accountId}::uuid`;
    return row?.done ?? null;
  }

  async function modeOf(runId: string): Promise<string | null> {
    const [row] = await prisma.$queryRaw<{ mode: string }[]>`SELECT mode FROM run WHERE run_id = ${runId}`;
    return row?.mode ?? null;
  }

  async function headersOf(me: AccountRef): Promise<Record<string, string>> {
    const token = await signAccessToken({ accountId: me.accountId, platform: "telegram", platformUserId: me.platformUserId }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    return { authorization: `Bearer ${token}` };
  }

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, DATABASE_URL } as NodeJS.ProcessEnv);
    prisma = testPrisma(DATABASE_URL, 12);
    accounts = new PrismaAccountRepository(prisma);
    const roles = new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository());
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, roles);
    prologue = new PrologueService(new PrismaPrologueStore(prisma), wallet, panelSettings());
    runs = new PrismaRunsRepository(prisma);
    board = new MemoryLeaderboardStore();
    recorded = [];
    const hooks = new RunsHooks();
    hooks.onRecorded("test", async (run) => {
      recorded.push(run);
    });
    const rating = ratingRestrictions(runs, board);
    service = new RunsService(config, runs, board, roles, hooks, new RunContinues(), new RunLoadouts(), rating.rating, prologue);
    view = new RunsViewService(runs, board, new RunExtras(), rating.rating, new RunPrestige(), prologue);
    const progress = { view: async () => ({ level: 1 }) } as unknown as ProgressService;
    daily = new DailyService(new PrismaDailyRepository(prisma), progress, wallet, prologue);
    const unused = {} as never;
    tasks = new TasksService(new PrismaTasksRepository(prisma), wallet, new RunsHooks(), unused, unused, unused, unused, undefined, undefined, prologue);

    @Module({
      controllers: [RunsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: RunsService, useValue: service },
        { provide: RunsViewService, useValue: view },
        { provide: RateLimiter, useValue: { consume: async () => true } },
        { provide: RunProofsService, useValue: {} },
        AuthGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  describe("победа", () => {
    it("новый аккаунт: победа в прологе ставит признак, даёт 500 монет и 10 самоцветов и открывает профиль", async () => {
      const me = await person();
      expect((await view.profile(me.accountId)).prologueDone).toBe(false);
      const runId = randomUUID();

      const result = await service.finish(me, prologueBody(runId), NOON.getTime());

      expect(result.recorded).toBe(false);
      expect(await doneAt(me.accountId)).not.toBeNull();
      expect(await balances(me.accountId)).toEqual({ coins: 500, gems: 10 });
      expect(await prologueEntries(me.accountId)).toEqual([
        { resource: "coins", amount: 500 },
        { resource: "gems", amount: 10 },
      ]);
      expect(await modeOf(runId)).toBe("prologue");
      expect((await view.profile(me.accountId)).prologueDone).toBe(true);
    });

    it("награда — по ключам панели: меньше умолчания, нуль не начисляется", async () => {
      const me = await person();
      const custom = new PrologueService(
        new PrismaPrologueStore(prisma),
        wallet,
        panelSettings({ [SETTINGS.prologueRewardCoins.key]: 200, [SETTINGS.prologueRewardGems.key]: 0 }),
      );
      await custom.settle({ accountId: me.accountId, at: NOON });
      expect(await balances(me.accountId)).toEqual({ coins: 200, gems: 0 });
    });

    it("два запроса разом с одним забегом — одно начисление и одна запись", async () => {
      const me = await person();
      const runId = randomUUID();

      await Promise.all([service.finish(me, prologueBody(runId), NOON.getTime()), service.finish(me, prologueBody(runId), NOON.getTime())]);

      expect(await balances(me.accountId)).toEqual({ coins: 500, gems: 10 });
      expect(await prologueEntries(me.accountId)).toHaveLength(2);
      expect(await prisma.run.count({ where: { runId } })).toBe(1);
    });

    it("два разных забега-пролога разом — награда одна, признак один", async () => {
      const me = await person();
      const [first, second] = [randomUUID(), randomUUID()];

      await Promise.all([service.finish(me, prologueBody(first), NOON.getTime()), service.finish(me, prologueBody(second), NOON.getTime())]);

      expect(await balances(me.accountId)).toEqual({ coins: 500, gems: 10 });
      expect(await prologueEntries(me.accountId)).toHaveLength(2);
      expect(await doneAt(me.accountId)).not.toBeNull();
    });

    it("тот же итог после успеха: режим остаётся prologue, награды второй раз нет", async () => {
      const me = await person();
      const runId = randomUUID();
      await service.finish(me, prologueBody(runId), NOON.getTime());

      const again = await service.finish(me, prologueBody(runId), NOON.getTime() + 60_000);

      expect(again.recorded).toBe(false);
      expect(await modeOf(runId)).toBe("prologue");
      expect(await balances(me.accountId)).toEqual({ coins: 500, gems: 10 });
      expect(await prologueEntries(me.accountId)).toHaveLength(2);
      expect(await prisma.run.count({ where: { runId } })).toBe(1);
    });

    it("повторный пролог пройденного аккаунта — обычный забег: награды нет, режим endless", async () => {
      const me = await person();
      await service.finish(me, prologueBody(randomUUID()), NOON.getTime());
      const again = randomUUID();

      await service.finish(me, prologueBody(again), NOON.getTime() + 60_000);

      expect(await balances(me.accountId)).toEqual({ coins: 500, gems: 10 });
      expect(await modeOf(again)).toBe("endless");
      expect(recorded.find((run) => run.runId === again)?.mode).toBe("endless");
    });

    it("отклонённый вердикт победы не засчитывает: признак пуст, наград нет", async () => {
      const me = await person();
      // Пять оружий при четырёх слотах — отказ антифрода.
      const weapons = Array.from({ length: 5 }, (_, index) => ({ id: `w${String(index)}`, level: 1 }));

      await service.finish(me, prologueBody(randomUUID(), { weapons }), NOON.getTime());

      expect(await doneAt(me.accountId)).toBeNull();
      expect(await balances(me.accountId)).toEqual({ coins: 0, gems: 0 });
    });
  });

  describe("подделка победы", () => {
    it("prologue.won на тридцатой секунде: забег записан, признак пуст, награды нет", async () => {
      const me = await person();
      const runId = randomUUID();

      await service.finish(me, prologueBody(runId, { survivalSec: 30, prologue: { won: true, sec: 30 } }), NOON.getTime());

      expect(await modeOf(runId)).toBe("prologue");
      expect(await doneAt(me.accountId)).toBeNull();
      expect(await balances(me.accountId)).toEqual({ coins: 0, gems: 0 });
    });

    it("секунда победы расходится с длиной забега больше чем на секунду: награды нет", async () => {
      const me = await person();

      await service.finish(me, prologueBody(randomUUID(), { survivalSec: 170, prologue: { won: true, sec: 100 } }), NOON.getTime());

      expect(await doneAt(me.accountId)).toBeNull();
      expect(await balances(me.accountId)).toEqual({ coins: 0, gems: 0 });
    });
  });

  describe("выход без победы", () => {
    it("забег записан, признак пуст, наград нет — следующий запуск снова пролог", async () => {
      const me = await person();
      const runId = randomUUID();

      await service.finish(me, prologueBody(runId, { prologue: { won: false, sec: 90 }, survivalSec: 90 }), NOON.getTime());

      expect(await modeOf(runId)).toBe("prologue");
      expect(await doneAt(me.accountId)).toBeNull();
      expect(await balances(me.accountId)).toEqual({ coins: 0, gems: 0 });
      expect((await view.profile(me.accountId)).prologueDone).toBe(false);

      // Второй заход пролога выигран — вот теперь награда.
      await service.finish(me, prologueBody(randomUUID()), NOON.getTime() + 120_000);
      expect(await balances(me.accountId)).toEqual({ coins: 500, gems: 10 });
    });
  });

  describe("рейтинг и задания", () => {
    it("пролог не попадает в рейтинг и не засчитывается заданиям", async () => {
      const me = await person();
      const runId = randomUUID();

      await service.finish(me, prologueBody(runId), NOON.getTime());

      const [row] = await prisma.$queryRaw<{ ranked: boolean }[]>`SELECT ranked FROM run WHERE run_id = ${runId}`;
      expect(row?.ranked).toBe(false);
      for (const difficulty of ["easy", "normal", "hard"] as const) {
        for (const side of ["full", "common"] as const) expect(await board.best(difficulty, me.accountId, side)).toBeNull();
      }
      const event = recorded.find((run) => run.runId === runId);
      expect(event?.mode).toBe("prologue");
      expect(event?.ranked).toBe(false);
      if (event === undefined) throw new Error("слушатель не получил забег");
      expect(countsForTasks(event)).toBe(false);
    });

    it("то же забег без пролога на лёгкой — задания считает по-прежнему", async () => {
      const me = await person();
      const runId = randomUUID();

      await service.finish(me, prologueBody(runId, { mode: "endless", prologue: undefined }), NOON.getTime());

      const event = recorded.find((run) => run.runId === runId);
      if (event === undefined) throw new Error("слушатель не получил забег");
      expect(countsForTasks(event)).toBe(true);
    });
  });

  describe("закрытые разделы", () => {
    it("награда дня до победы — 409 prologue_required, после — проходит", async () => {
      const me = await person();

      await expect(daily.claim(me.accountId, NOON)).rejects.toMatchObject({ code: "prologue_required", status: 409 });
      expect(await daily.badge(me.accountId, NOON)).toBe(0);

      await service.finish(me, prologueBody(randomUUID()), NOON.getTime());

      expect((await daily.claim(me.accountId, NOON)).claimed).toBe(true);
      expect(await daily.badge(me.accountId, NOON)).toBe(0);
    });

    it("забор задания до победы — 409 prologue_required, после ответ уже по существу", async () => {
      const me = await person();

      await expect(tasks.claim(me, "no_such_task", NOON)).rejects.toMatchObject({ code: "prologue_required", status: 409 });

      await service.finish(me, prologueBody(randomUUID()), NOON.getTime());

      await expect(tasks.claim(me, "no_such_task", NOON)).rejects.toBeInstanceOf(TaskNotFoundError);
    });
  });

  describe("аккаунты до пролога", () => {
    it("миграция ставит признак всем, у кого есть забег, и не трогает остальных", async () => {
      const veteran = await person();
      const newcomer = await person();
      const startedOnly = await person();
      await service.finish(veteran, prologueBody(randomUUID(), { mode: "endless", prologue: undefined, difficultyId: "hard" }), NOON.getTime());
      await runs.start({ runId: randomUUID(), accountId: startedOnly.accountId, difficulty: "hard", startingWeaponId: "knife", contentHash: "abc", startedAt: new Date() });
      // Миграционный запрос идёт по всем аккаунтам базы: сбрасываем признак у своих и откатываем всё в конце.
      let observed: Record<string, Date | null> = {};
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`UPDATE account SET prologue_done_at = NULL WHERE account_id IN (${veteran.accountId}::uuid, ${newcomer.accountId}::uuid, ${startedOnly.accountId}::uuid)`;
          for (const statement of migrationStatements().filter((sql) => /^UPDATE\b/i.test(sql))) await tx.$executeRawUnsafe(statement);
          const rows = await tx.$queryRaw<{ account_id: string; done: Date | null }[]>`
            SELECT account_id::text AS account_id, prologue_done_at AS done FROM account
            WHERE account_id IN (${veteran.accountId}::uuid, ${newcomer.accountId}::uuid, ${startedOnly.accountId}::uuid)`;
          observed = Object.fromEntries(rows.map((row) => [row.account_id, row.done]));
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);

      expect(observed[veteran.accountId]).toBeInstanceOf(Date);
      expect(observed[startedOnly.accountId]).toBeInstanceOf(Date);
      expect(observed[newcomer.accountId]).toBeNull();
    });

    it("игрок с забегами видит профиль с prologueDone: true, разделы ему открыты", async () => {
      const veteran = await person();
      await service.finish(veteran, prologueBody(randomUUID(), { mode: "endless", prologue: undefined, difficultyId: "hard" }), NOON.getTime());
      // Старый аккаунт: признак поставила миграция, а не пролог.
      await prisma.$executeRaw`UPDATE account SET prologue_done_at = now() WHERE account_id = ${veteran.accountId}::uuid`;

      expect((await view.profile(veteran.accountId)).prologueDone).toBe(true);
      await expect(tasks.claim(veteran, "no_such_task", NOON)).rejects.toBeInstanceOf(TaskNotFoundError);
    });
  });

  describe("запись забега по HTTP", () => {
    it("старый клиент без mode — обычный забег: признак не ставится, режим endless", async () => {
      const me = await person();
      const runId = randomUUID();
      // Тело сборки до пролога: без полей режима и пролога.
      const legacy: Record<string, unknown> = { ...prologueBody(runId, { difficultyId: "hard", outcome: "died", deathCause: "swarm_rat" }) };
      delete legacy.mode;
      delete legacy.prologue;
      const http = app;
      if (http === null) throw new Error("приложение не запущено");

      const response = await http.inject({ method: "POST", url: "/api/v1/runs", headers: await headersOf(me), payload: legacy });

      expect(response.statusCode).toBe(201);
      expect(await modeOf(runId)).toBe("endless");
      expect(await doneAt(me.accountId)).toBeNull();
    });

    it("пролог на сложной — 400 run_invalid, забег не записан", async () => {
      const me = await person();
      const runId = randomUUID();
      const http = app;
      if (http === null) throw new Error("приложение не запущено");

      const response = await http.inject({ method: "POST", url: "/api/v1/runs", headers: await headersOf(me), payload: prologueBody(runId, { difficultyId: "hard" }) });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe("run_invalid");
      expect(await prisma.run.count({ where: { runId } })).toBe(0);
    });

    it("победа в прологе по HTTP и GET /runs/me с prologueDone", async () => {
      const me = await person();
      const http = app;
      if (http === null) throw new Error("приложение не запущено");
      const headers = await headersOf(me);

      const before = await http.inject({ method: "GET", url: "/api/v1/runs/me", headers });
      expect(before.json<{ data: ProfileView }>().data.prologueDone).toBe(false);

      const won = await http.inject({ method: "POST", url: "/api/v1/runs", headers, payload: prologueBody(randomUUID()) });
      expect(won.statusCode).toBe(201);

      const after = await http.inject({ method: "GET", url: "/api/v1/runs/me", headers });
      expect(after.json<{ data: ProfileView }>().data.prologueDone).toBe(true);
    });

    it("старт пролога несёт режим и записывается в строку забега", async () => {
      const me = await person();
      const runId = randomUUID();
      const http = app;
      if (http === null) throw new Error("приложение не запущено");

      const response = await http.inject({
        method: "POST",
        url: "/api/v1/runs/start",
        headers: await headersOf(me),
        payload: { runId, difficultyId: "easy", mode: "prologue", startingWeaponId: "knife", contentHash: "abc", elapsedSec: 0 },
      });

      expect(response.statusCode).toBe(201);
      expect(await modeOf(runId)).toBe("prologue");
    });
  });
});
