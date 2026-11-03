import { Logger } from "@nestjs/common";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { DEFAULT_RIBBON } from "../src/modules/battle-pass/pass-defaults.js";
import { PassAlreadyClaimedError, PassTierNotReachedError, PassVipRequiredError } from "../src/modules/battle-pass/pass-errors.js";
import { passGrantKey, rewardLines, tierOf } from "../src/modules/battle-pass/pass-rules.js";
import { PrismaBattlePassRepository } from "../src/modules/battle-pass/battle-pass.repository.js";
import { BattlePassService } from "../src/modules/battle-pass/battle-pass.service.js";
import type { AccountRef } from "../src/modules/roles/roles.service.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { PrismaTasksRepository } from "../src/modules/tasks/tasks.repository.js";
import { TasksService } from "../src/modules/tasks/tasks.service.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { panelSettings } from "./helpers/settings.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Батл-пасс на живом Postgres (docs/17-testing-strategy.md §4.2; адрес —
 * TEST_DATABASE_URL, без него пропуск; tasks/T-0311): очки пасса за забор
 * задания, 30 ступеней двух лент, забор награды ровно один раз — и подряд, и
 * под гонкой, VIP-лента по VIP в момент забора.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
/** вторник, 10.11.2026, 12:00 по Москве */
const NOON = new Date("2026-11-10T09:00:00Z");
const MONTH = "2026-11";

describe.skipIf(DATABASE_URL === "")("батл-пасс на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let tasks: PrismaTasksRepository;
  let wallet: WalletService;
  let repository: PrismaBattlePassRepository;
  let pass: BattlePassService;
  let service: TasksService;
  const settings = panelSettings();
  /** кто сейчас с VIP: подмена `VipService.activeAt`, VIP-периоды проверяет свой тест */
  const vipNow = new Set<string>();
  const taskIds: string[] = [];
  const seasonMonths: string[] = [];

  async function person(): Promise<AccountRef> {
    const created = await accounts.upsert({ platform: "telegram", platformUserId: String(790_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Пасс", username: null }, Date.now());
    return { accountId: created.accountId, platform: "telegram", platformUserId: "1" };
  }

  /** Очки пасса игрока в месяце: прямо из таблицы, не через сервис. */
  async function pointsOf(accountId: string, month = MONTH): Promise<number | null> {
    const rows = await prisma.$queryRaw<{ points: number }[]>`SELECT points FROM pass_progress WHERE account_id = ${accountId}::uuid AND month_key = ${month}`;
    return rows[0]?.points ?? null;
  }

  /** Очки, набранные игроком: ровно столько, чтобы стоять на нужной ступени. */
  async function reachTier(accountId: string, tier: number, month = MONTH): Promise<void> {
    await repository.addPoints(accountId, month, tier * 100, NOON);
  }

  async function ledger(accountId: string, resource?: string): Promise<{ count: number; amount: number }> {
    const rows = await prisma.$queryRaw<{ amount: number }[]>`
      SELECT amount::int AS amount FROM wallet_entry
      WHERE account_id = ${accountId}::uuid AND reason = 'pass_reward' AND (${resource ?? null}::text IS NULL OR resource::text = ${resource ?? null})`;
    return { count: rows.length, amount: rows.reduce((sum, row) => sum + row.amount, 0) };
  }

  async function journal(accountId: string): Promise<{ tier: number; lane: string }[]> {
    return await prisma.$queryRaw<{ tier: number; lane: string }[]>`SELECT tier::int AS tier, lane FROM pass_claim WHERE account_id = ${accountId}::uuid ORDER BY tier, lane`;
  }

  async function boosts(accountId: string): Promise<Record<string, number>> {
    const rows = await prisma.$queryRaw<{ boost_id: string; count: number }[]>`SELECT boost_id, count FROM boost_credit WHERE account_id = ${accountId}::uuid`;
    return Object.fromEntries(rows.map((row) => [row.boost_id, row.count]));
  }

  let runNo = 0;

  /** Задание с очками пасса, выполненное игроком в момент `at`, готовое к забору. */
  async function doneTask(accountId: string, taskId: string, at: Date): Promise<void> {
    await tasks.applyRun({ runId: `pass-it-${String(Date.now())}-${String(runNo++)}`, accountId, at, deltas: [{ taskId, period: "daily", target: 1, op: "sum", amount: 1 }] });
  }

  async function addTask(taskId: string, passPoints: number): Promise<void> {
    taskIds.push(taskId);
    await prisma.$executeRaw`
      INSERT INTO task_def (task_id, period, kind, target, coins, pass_points, params, created_at, updated_at)
      VALUES (${taskId}, 'daily', 'runs', 1, 10, ${passPoints}, NULL, now(), now())
      ON CONFLICT (task_id) DO UPDATE SET pass_points = ${passPoints}, active = true`;
    service.forgetCatalog();
  }

  beforeAll(async () => {
    const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, DATABASE_URL } as NodeJS.ProcessEnv);
    prisma = testPrisma(DATABASE_URL, 12);
    accounts = new PrismaAccountRepository(prisma);
    tasks = new PrismaTasksRepository(prisma);
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository()));
    repository = new PrismaBattlePassRepository(prisma);
    pass = new BattlePassService(repository, wallet, { activeAt: (accountId) => Promise.resolve(vipNow.has(accountId)) }, settings);
    const unused = {} as never;
    service = new TasksService(tasks, wallet, new RunsHooks(), unused, unused, unused, unused, undefined, pass);
    await addTask("it_pass_40", 40);
    await addTask("it_pass_25", 25);
    await addTask("it_pass_zero", 0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    settings.set(SETTINGS.passPointsPerTier.key, 100);
  });

  afterAll(async () => {
    for (const month of seasonMonths) await prisma.$executeRaw`DELETE FROM pass_season WHERE month_key = ${month}`;
    for (const taskId of taskIds) {
      await prisma.$executeRaw`DELETE FROM task_progress WHERE task_id = ${taskId}`;
      await prisma.$executeRaw`DELETE FROM task_def WHERE task_id = ${taskId}`;
    }
    await prisma.$disconnect();
  });

  describe("очки пасса за забор задания", () => {
    it("забор задания с 40 очками пасса прибавляет 40; повтор забора не удваивает", async () => {
      const me = await person();
      await doneTask(me.accountId, "it_pass_40", NOON);
      const first = await service.claim(me, "it_pass_40", NOON);
      expect(first.claimed).toBe(true);
      expect(await pointsOf(me.accountId)).toBe(40);

      const again = await service.claim(me, "it_pass_40", NOON);
      expect(again.claimed).toBe(false);
      expect(await pointsOf(me.accountId)).toBe(40);
    });

    it("два забора одного задания разом — очки один раз", async () => {
      const me = await person();
      await doneTask(me.accountId, "it_pass_40", NOON);
      await Promise.allSettled(Array.from({ length: 6 }, () => service.claim(me, "it_pass_40", NOON)));
      expect(await pointsOf(me.accountId)).toBe(40);
    });

    it("очки разных заданий складываются, а у задания без очков строки пасса не заводится", async () => {
      const me = await person();
      await doneTask(me.accountId, "it_pass_zero", NOON);
      await service.claim(me, "it_pass_zero", NOON);
      expect(await pointsOf(me.accountId)).toBeNull();

      await doneTask(me.accountId, "it_pass_40", NOON);
      await doneTask(me.accountId, "it_pass_25", NOON);
      await service.claim(me, "it_pass_40", NOON);
      await service.claim(me, "it_pass_25", NOON);
      expect(await pointsOf(me.accountId)).toBe(65);
    });

    it("очки идут в месяц забора по Москве: 20:59 UTC 31 октября — октябрь, 21:00 — ноябрь", async () => {
      const me = await person();
      const october = new Date("2026-10-31T20:59:00Z");
      const november = new Date("2026-10-31T21:00:00Z");
      await doneTask(me.accountId, "it_pass_40", october);
      await service.claim(me, "it_pass_40", october);
      await doneTask(me.accountId, "it_pass_25", november);
      await service.claim(me, "it_pass_25", november);
      expect(await pointsOf(me.accountId, "2026-10")).toBe(40);
      expect(await pointsOf(me.accountId, "2026-11")).toBe(25);
    });

    it("параллельные прибавки не теряются: 20 заборов по 5 очков — 100", async () => {
      const me = await person();
      await Promise.all(Array.from({ length: 20 }, () => repository.addPoints(me.accountId, MONTH, 5, NOON)));
      expect(await pointsOf(me.accountId)).toBe(100);
    });

    it("переход через ступень пишет pass_tier_reached по каждой взятой ступени, внутри ступени — ничего", async () => {
      const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
      const me = await person();
      await pass.addTaskPoints(me.accountId, 90, NOON);
      expect(reached(log)).toEqual([]);
      await pass.addTaskPoints(me.accountId, 250, NOON);
      expect(reached(log)).toEqual([1, 2, 3]);
      await pass.addTaskPoints(me.accountId, 5, NOON);
      expect(reached(log)).toEqual([1, 2, 3]);
    });

    it("сбой прибавки очков не отменяет забор задания: награда выдана, ответ успешный", async () => {
      const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      const me = await person();
      await doneTask(me.accountId, "it_pass_40", NOON);
      vi.spyOn(repository, "addPoints").mockRejectedValueOnce(new Error("база недоступна"));
      const result = await service.claim(me, "it_pass_40", NOON);
      expect(result.claimed).toBe(true);
      expect(error.mock.calls.map(([line]) => String(line)).some((line) => line.includes("pass_points_failed"))).toBe(true);
    });
  });

  describe("забор награды ступени", () => {
    it("ступень 2 бесплатной — монеты по ленте; повтор — 409 без второго начисления", async () => {
      const me = await person();
      await reachTier(me.accountId, 2);
      const result = await pass.claim(me, 2, "free", NOON);
      expect(result).toMatchObject({ tier: 2, lane: "free", credited: { coins: DEFAULT_RIBBON[1]?.free.coins } });
      expect(await ledger(me.accountId, "coins")).toEqual({ count: 1, amount: DEFAULT_RIBBON[1]?.free.coins });

      const repeat = await pass.claim(me, 2, "free", NOON).catch((error: unknown) => error);
      expect(repeat).toBeInstanceOf(PassAlreadyClaimedError);
      expect(repeat).toMatchObject({ code: "pass_already_claimed", status: 409 });
      expect(await ledger(me.accountId, "coins")).toEqual({ count: 1, amount: DEFAULT_RIBBON[1]?.free.coins });
      expect(await journal(me.accountId)).toEqual([{ tier: 2, lane: "free" }]);
    });

    it("ступень с бустом: boost_credit +1, повтор его не увеличивает", async () => {
      const me = await person();
      await reachTier(me.accountId, 5);
      const boost = DEFAULT_RIBBON[4]?.free.boost;
      expect(boost).toBeDefined();
      const result = await pass.claim(me, 5, "free", NOON);
      expect(result.credited.boost).toEqual(boost);
      expect(await boosts(me.accountId)).toEqual({ [boost?.id ?? ""]: boost?.count });

      await expect(pass.claim(me, 5, "free", NOON)).rejects.toBeInstanceOf(PassAlreadyClaimedError);
      expect(await boosts(me.accountId)).toEqual({ [boost?.id ?? ""]: boost?.count });
    });

    it("подарки одного буста с разных ступеней складываются в одну строку", async () => {
      const me = await person();
      await prisma.$executeRaw`INSERT INTO boost_credit (account_id, boost_id, count) VALUES (${me.accountId}::uuid, 'fury', 2)`;
      await repository.claim({ accountId: me.accountId, monthKey: MONTH, tier: 1, lane: "free", boost: { id: "fury", count: 1 }, at: NOON });
      expect(await boosts(me.accountId)).toEqual({ fury: 3 });
    });

    it("ступень выше достигнутой — 409, ничего не записано", async () => {
      const me = await person();
      await reachTier(me.accountId, 2);
      const error = await pass.claim(me, 3, "free", NOON).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(PassTierNotReachedError);
      expect(error).toMatchObject({ code: "pass_tier_not_reached", status: 409 });
      expect(await journal(me.accountId)).toEqual([]);
      expect(await ledger(me.accountId)).toEqual({ count: 0, amount: 0 });
    });

    it("игрок без очков не забирает даже первую ступень", async () => {
      const me = await person();
      await expect(pass.claim(me, 1, "free", NOON)).rejects.toBeInstanceOf(PassTierNotReachedError);
    });

    it("VIP-лента без VIP — 409, ничего не записано; после покупки VIP та же ступень забирается", async () => {
      const me = await person();
      await reachTier(me.accountId, 3);
      const error = await pass.claim(me, 1, "vip", NOON).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(PassVipRequiredError);
      expect(error).toMatchObject({ code: "pass_vip_required", status: 409 });
      expect(await journal(me.accountId)).toEqual([]);
      expect(await ledger(me.accountId)).toEqual({ count: 0, amount: 0 });

      vipNow.add(me.accountId);
      await pass.claim(me, 1, "vip", NOON);
      expect(await journal(me.accountId)).toEqual([{ tier: 1, lane: "vip" }]);
    });

    it("купил VIP на 12-й ступени — VIP-награды 1…12 забираются, 13-я нет", async () => {
      const me = await person();
      await reachTier(me.accountId, 12);
      for (let tier = 1; tier <= 12; tier++) await expect(pass.claim(me, tier, "vip", NOON)).rejects.toBeInstanceOf(PassVipRequiredError);

      vipNow.add(me.accountId);
      for (let tier = 1; tier <= 12; tier++) await pass.claim(me, tier, "vip", NOON);
      await expect(pass.claim(me, 13, "vip", NOON)).rejects.toBeInstanceOf(PassTierNotReachedError);

      expect(await journal(me.accountId)).toEqual(Array.from({ length: 12 }, (_, index) => ({ tier: index + 1, lane: "vip" })));
      const expectedGems = DEFAULT_RIBBON.slice(0, 12).reduce((sum, tier) => sum + (tier.vip.gems ?? 0), 0);
      expect(await ledger(me.accountId, "gems")).toMatchObject({ amount: expectedGems });
    });

    it("VIP закончился — забранное остаётся забранным, незабранное VIP-ленты закрывается снова", async () => {
      const me = await person();
      await reachTier(me.accountId, 2);
      vipNow.add(me.accountId);
      await pass.claim(me, 1, "vip", NOON);
      vipNow.delete(me.accountId);
      await expect(pass.claim(me, 1, "vip", NOON)).rejects.toBeInstanceOf(PassAlreadyClaimedError);
      await expect(pass.claim(me, 2, "vip", NOON)).rejects.toBeInstanceOf(PassVipRequiredError);
      await pass.claim(me, 2, "free", NOON);
    });

    it("две ленты одной ступени — два независимых забора", async () => {
      const me = await person();
      await reachTier(me.accountId, 4);
      vipNow.add(me.accountId);
      await Promise.all([pass.claim(me, 4, "free", NOON), pass.claim(me, 4, "vip", NOON)]);
      expect(await journal(me.accountId)).toEqual([
        { tier: 4, lane: "free" },
        { tier: 4, lane: "vip" },
      ]);
    });

    it("шаг ступени берётся из настройки pass.points-per-tier", async () => {
      const me = await person();
      await repository.addPoints(me.accountId, MONTH, 250, NOON);
      await expect(pass.claim(me, 3, "free", NOON)).rejects.toBeInstanceOf(PassTierNotReachedError);
      settings.set(SETTINGS.passPointsPerTier.key, 50);
      expect((await pass.view(me, NOON)).tier).toBe(5);
      await pass.claim(me, 5, "free", NOON);
    });

    it("очки прошлого месяца ступеней нового не дают", async () => {
      const me = await person();
      await reachTier(me.accountId, 10, "2026-10");
      await expect(pass.claim(me, 1, "free", NOON)).rejects.toBeInstanceOf(PassTierNotReachedError);
    });
  });

  describe("гонки и сбои", () => {
    it("два запроса забора разом — одно начисление; остальные получают 409", async () => {
      const me = await person();
      await reachTier(me.accountId, 5);
      const results = await Promise.allSettled([pass.claim(me, 5, "free", NOON), pass.claim(me, 5, "free", NOON)]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(await ledger(me.accountId, "coins")).toEqual({ count: 1, amount: DEFAULT_RIBBON[4]?.free.coins });
      expect(await journal(me.accountId)).toEqual([{ tier: 5, lane: "free" }]);
    });

    it("десять запросов разом на ступень с бустом и осколками: монеты, осколки и подарок — по одному разу", async () => {
      const me = await person();
      await reachTier(me.accountId, 15);
      const reward = DEFAULT_RIBBON[14]?.free;
      const results = await Promise.allSettled(Array.from({ length: 10 }, () => pass.claim(me, 15, "free", NOON)));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      for (const rejected of results.filter((result): result is PromiseRejectedResult => result.status === "rejected")) expect(rejected.reason).toBeInstanceOf(PassAlreadyClaimedError);
      for (const line of rewardLines(reward ?? {})) expect(await ledger(me.accountId, line.resource), line.resource).toEqual({ count: 1, amount: line.amount });
      expect(await boosts(me.accountId)).toEqual({ [reward?.boost?.id ?? ""]: reward?.boost?.count });
    });

    it("сбой между начислением и журналом: повтор довыдаёт подарок и журнал, кошелёк не удваивается", async () => {
      const me = await person();
      await reachTier(me.accountId, 5);
      const reward = DEFAULT_RIBBON[4]?.free;
      // Процесс умер после кошелька и до журнала: деньги по ключу уже лежат, строки журнала и подарка нет.
      for (const line of rewardLines(reward ?? {})) {
        await wallet.grant({ accountId: me.accountId, resource: line.resource, amount: line.amount, reason: "pass_reward", source: "pass:2026-11:5:free", idempotencyKey: passGrantKey(MONTH, 5, "free", me.accountId, line.resource), at: NOON });
      }
      expect(await journal(me.accountId)).toEqual([]);

      const result = await pass.claim(me, 5, "free", NOON);
      expect(result.tier).toBe(5);
      expect(await ledger(me.accountId, "coins")).toEqual({ count: 1, amount: reward?.coins });
      expect(await journal(me.accountId)).toEqual([{ tier: 5, lane: "free" }]);
      expect(await boosts(me.accountId)).toEqual({ [reward?.boost?.id ?? ""]: reward?.boost?.count });
    });

    it("сбой кошелька: журнал и подарок не записаны, повтор забирает целиком", async () => {
      const me = await person();
      await reachTier(me.accountId, 5);
      vi.spyOn(wallet, "grant").mockRejectedValueOnce(new Error("кошелёк недоступен"));
      await expect(pass.claim(me, 5, "free", NOON)).rejects.toThrow("кошелёк недоступен");
      expect(await journal(me.accountId)).toEqual([]);
      expect(await boosts(me.accountId)).toEqual({});

      vi.restoreAllMocks();
      await pass.claim(me, 5, "free", NOON);
      expect(await journal(me.accountId)).toEqual([{ tier: 5, lane: "free" }]);
    });

    it("забор не обходит суточный потолок кошелька: сверх потолка ложится меньше, а ступень всё равно забрана", async () => {
      const me = await person();
      await reachTier(me.accountId, 1);
      await prisma.$executeRaw`
        INSERT INTO wallet_daily (account_id, resource, reason, day, granted)
        VALUES (${me.accountId}::uuid, 'coins', 'pass_reward', (${NOON}::timestamptz AT TIME ZONE 'Europe/Moscow')::date, 999999999)`;
      const result = await pass.claim(me, 1, "free", NOON);
      expect(result.credited.coins ?? 0).toBe(0);
      expect(await journal(me.accountId)).toEqual([{ tier: 1, lane: "free" }]);
    });
  });

  describe("GET /pass", () => {
    it("ответ: месяц, конец месяца в UTC, очки, ступень, VIP и забранное по лентам", async () => {
      const me = await person();
      await repository.addPoints(me.accountId, MONTH, 250, NOON);
      await pass.claim(me, 1, "free", NOON);
      const view = await pass.view(me, NOON);
      expect(view).toMatchObject({ monthKey: MONTH, endsAt: "2026-11-30T21:00:00.000Z", points: 250, tier: 2, pointsPerTier: 100, vip: false });
      expect(view.tiers).toHaveLength(30);
      expect(view.tiers[0]).toMatchObject({ tier: 1, claimed: { free: true, vip: false } });
      expect(view.tiers[1]).toMatchObject({ tier: 2, claimed: { free: false, vip: false } });
      vipNow.add(me.accountId);
      expect((await pass.view(me, NOON)).vip).toBe(true);
    });

    it("новичок: нулевая ступень, ленты по умолчанию", async () => {
      const me = await person();
      const view = await pass.view(me, NOON);
      expect(view).toMatchObject({ points: 0, tier: 0 });
      expect(view.tiers.map((tier) => tier.free)).toEqual(DEFAULT_RIBBON.map((tier) => tier.free));
    });

    it("игрок видит только свои очки и свои забранные награды", async () => {
      const first = await person();
      const second = await person();
      await reachTier(first.accountId, 3);
      await pass.claim(first, 1, "free", NOON);
      const other = await pass.view(second, NOON);
      expect(other.points).toBe(0);
      expect(other.tiers[0]?.claimed).toEqual({ free: false, vip: false });
    });
  });

  describe("лента месяца из базы", () => {
    const FUTURE = "2031-05";
    const FUTURE_AT = new Date("2031-05-12T09:00:00Z");

    async function publish(month: string, tiers: unknown): Promise<void> {
      seasonMonths.push(month);
      await prisma.$executeRaw`
        INSERT INTO pass_season (month_key, tiers, published_at) VALUES (${month}, ${JSON.stringify(tiers)}::jsonb, now())
        ON CONFLICT (month_key) DO UPDATE SET tiers = EXCLUDED.tiers`;
    }

    it("лента месяца заменяет ленту по умолчанию — и в ответе, и в забор", async () => {
      const custom = DEFAULT_RIBBON.map((tier) => (tier.tier === 1 ? { ...tier, free: { coins: 777 } } : tier));
      await publish(FUTURE, custom);
      const me = await person();
      await reachTier(me.accountId, 1, FUTURE);
      expect((await pass.view(me, FUTURE_AT)).tiers[0]?.free).toEqual({ coins: 777 });
      const result = await pass.claim(me, 1, "free", FUTURE_AT);
      expect(result.credited.coins).toBe(777);
    });

    it("порченая лента в базе не роняет пасс: работает лента по умолчанию, в лог — ошибка", async () => {
      const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      await publish(FUTURE, DEFAULT_RIBBON.map((tier) => (tier.tier === 2 ? { ...tier, free: { coins: -5 } } : tier)));
      const me = await person();
      const view = await pass.view(me, FUTURE_AT);
      expect(view.tiers.map((tier) => tier.free)).toEqual(DEFAULT_RIBBON.map((tier) => tier.free));
      expect(error.mock.calls.map(([line]) => String(line)).some((line) => line.includes("pass_season_invalid"))).toBe(true);
    });
  });

  describe("схема базы держит правила сама", () => {
    it("лента не той длины, неверная лента забора, ступень вне 1…30 и ключ месяца не в формате отвергаются", async () => {
      const me = await person();
      const id = me.accountId;
      await expect(prisma.$executeRaw`INSERT INTO pass_claim (account_id, month_key, tier, lane, claimed_at) VALUES (${id}::uuid, ${MONTH}, 1, 'gold', now())`).rejects.toThrow();
      await expect(prisma.$executeRaw`INSERT INTO pass_claim (account_id, month_key, tier, lane, claimed_at) VALUES (${id}::uuid, ${MONTH}, 31, 'free', now())`).rejects.toThrow();
      await expect(prisma.$executeRaw`INSERT INTO pass_claim (account_id, month_key, tier, lane, claimed_at) VALUES (${id}::uuid, ${MONTH}, 0, 'free', now())`).rejects.toThrow();
      await expect(prisma.$executeRaw`INSERT INTO pass_claim (account_id, month_key, tier, lane, claimed_at) VALUES (${id}::uuid, '2026-13', 1, 'free', now())`).rejects.toThrow();
      await expect(prisma.$executeRaw`INSERT INTO pass_progress (account_id, month_key, points, updated_at) VALUES (${id}::uuid, ${MONTH}, -1, now())`).rejects.toThrow();
      await expect(prisma.$executeRaw`INSERT INTO boost_credit (account_id, boost_id, count) VALUES (${id}::uuid, 'fury', -1)`).rejects.toThrow();
      await expect(prisma.$executeRaw`INSERT INTO pass_season (month_key, tiers, published_at) VALUES ('2031-06', '[]'::jsonb, now())`).rejects.toThrow();
    });

    it("журнал забора уникален по аккаунту, месяцу, ступени и ленте", async () => {
      const me = await person();
      await prisma.$executeRaw`INSERT INTO pass_claim (account_id, month_key, tier, lane, claimed_at) VALUES (${me.accountId}::uuid, ${MONTH}, 7, 'free', now())`;
      await expect(prisma.$executeRaw`INSERT INTO pass_claim (account_id, month_key, tier, lane, claimed_at) VALUES (${me.accountId}::uuid, ${MONTH}, 7, 'free', now())`).rejects.toThrow();
      await prisma.$executeRaw`INSERT INTO pass_claim (account_id, month_key, tier, lane, claimed_at) VALUES (${me.accountId}::uuid, ${MONTH}, 7, 'vip', now())`;
    });
  });

  it("ступень по очкам и по записи в таблице совпадают", async () => {
    const me = await person();
    await repository.addPoints(me.accountId, MONTH, 4_000, NOON);
    expect(tierOf(await repository.points(me.accountId, MONTH), 100)).toBe(30);
    expect((await pass.view(me, NOON)).tier).toBe(30);
  });
});

/** Ступени из строк `pass_tier_reached`, записанных в лог. */
function reached(log: { mock: { calls: unknown[][] } }): number[] {
  return log.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.includes('"pass_tier_reached"'))
    .map((line) => Number((JSON.parse(line) as { tier: number }).tier));
}
