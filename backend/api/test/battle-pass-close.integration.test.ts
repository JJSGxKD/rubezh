import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { closeRedis, createRedis } from "../src/infra/redis.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaBattlePassRepository } from "../src/modules/battle-pass/battle-pass.repository.js";
import { BattlePassService } from "../src/modules/battle-pass/battle-pass.service.js";
import { DEFAULT_RIBBON } from "../src/modules/battle-pass/pass-defaults.js";
import { PASS_CLOSE_LIMITS, PASS_CLOSE_LOCK_KEY, PassCloseService, type PassClosed, type PassCloseLimits } from "../src/modules/battle-pass/pass-close.service.js";
import { PrismaPassCloseRepository } from "../src/modules/battle-pass/pass-close.repository.js";
import { monthBounds, monthKeyOf, passGrantKey, rewardLines, type PassLane, type PassReward } from "../src/modules/battle-pass/pass-rules.js";
import { botMessageOf } from "../src/modules/notifications-bot/bot-notify-texts.js";
import { NOTIFICATION_KINDS } from "../src/modules/notifications/notification-kinds.js";
import { PrismaNotificationsRepository } from "../src/modules/notifications/notifications.repository.js";
import { NotificationsService } from "../src/modules/notifications/notifications.service.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import type { AccountRef } from "../src/modules/roles/roles.service.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { PrismaVipRepository } from "../src/modules/vip/vip.repository.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { redisDatabase } from "./helpers/redis-database.js";
import { panelSettings } from "./helpers/settings.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Закрытие месяца батл-пасса на живом Postgres (docs/17-testing-strategy.md
 * §4.2; адрес — TEST_DATABASE_URL, без него пропуск; Redis — по желанию,
 * PLAYTEST_TEST_REDIS_URL; tasks/T-0312). Память этого не покажет: «ровно один
 * раз» держат ключ кошелька и журнал `pass_claim` в базе, а не код, и проверять
 * его надо под настоящей гонкой — двумя заданиями разом, забором игрока
 * посреди закрытия и упавшим на полпути процессом.
 *
 * Каждый тест берёт свой месяц далёкого будущего (с 2100 года): база общая для
 * всех прогонов, а закрытие обходит **всех** игроков месяца — чужих в нём быть
 * не должно.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 15);
const DAY = 86_400_000;
const RACE_TIMEOUT_MS = 60_000;

/** Без пауз между повторами; пачка по умолчанию — настоящая. */
const FAST: PassCloseLimits = { ...PASS_CLOSE_LIMITS, retryDelayMs: 0 };

type LockRedis = ConstructorParameters<typeof PassCloseService>[0];

/** Redis замка в памяти: `SET NX` и два скрипта — продление и снятие. Свой у каждой «реплики». */
class FakeLockRedis {
  readonly values = new Map<string, string>();
  renewals = 0;
  /** с какого по счёту продления замок «пропал»: 0 — не пропадает */
  dropAtRenewal = 0;

  async set(key: string, value: string): Promise<"OK" | null> {
    if (this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async eval(script: string, _keys: number, key: string, token: string): Promise<number> {
    if (script.includes("PEXPIRE")) {
      this.renewals++;
      if (this.dropAtRenewal > 0 && this.renewals >= this.dropAtRenewal) this.values.delete(key);
      return this.values.get(key) === token ? 1 : 0;
    }
    if (this.values.get(key) !== token) return 0;
    this.values.delete(key);
    return 1;
  }
}

function asLock(redis: FakeLockRedis | Redis): LockRedis {
  return redis as unknown as LockRedis;
}

/**
 * Итог закрытия по месяцу. Задание закрывает и пустые месяцы окна догона, поэтому
 * список целиком тесты не сравнивают — только свой месяц.
 */
function forMonth(closed: PassClosed[] | null, month: string): PassClosed | undefined {
  return closed?.find((item) => item.monthKey === month);
}

describe.skipIf(DATABASE_URL === "")("закрытие месяца пасса на живом Postgres", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let wallet: WalletService;
  let notifications: NotificationsService;
  let passRepository: PrismaBattlePassRepository;
  let closeRepository: PrismaPassCloseRepository;
  let vipRepository: PrismaVipRepository;
  let pass: BattlePassService;
  let realRedis: Redis | null = null;
  const settings = panelSettings();
  /** кто сейчас с VIP для ручного забора: подмена `VipService.activeAt` */
  const vipNow = new Set<string>();
  const usedMonths = new Set<string>();

  async function person(): Promise<AccountRef> {
    const created = await accounts.upsert({ platform: "telegram", platformUserId: String(780_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Закрытие", username: null }, Date.now());
    return { accountId: created.accountId, platform: "telegram", platformUserId: "1" };
  }

  function shift(month: string, delta: number): string {
    const [year, number] = month.split("-").map(Number) as [number, number];
    return monthKeyOf(new Date(Date.UTC(year, number - 1 + delta, 15)));
  }

  async function wipeMonth(month: string): Promise<void> {
    await prisma.$executeRaw`DELETE FROM pass_close WHERE month_key = ${month}`;
    await prisma.$executeRaw`DELETE FROM pass_claim WHERE month_key = ${month}`;
    await prisma.$executeRaw`DELETE FROM pass_progress WHERE month_key = ${month}`;
    await prisma.$executeRaw`DELETE FROM pass_season WHERE month_key = ${month}`;
  }

  /** Месяц далёкого будущего, на котором и на трёх до него нет ни следа чужих прогонов. */
  async function freeMonth(): Promise<string> {
    for (;;) {
      const month = `${String(2100 + Math.floor(Math.random() * 800))}-${String(1 + Math.floor(Math.random() * 12)).padStart(2, "0")}`;
      const span = [-3, -2, -1, 0, 1].map((delta) => shift(month, delta));
      if (span.some((key) => usedMonths.has(key))) continue;
      for (const key of span) {
        usedMonths.add(key);
        await wipeMonth(key);
      }
      return month;
    }
  }

  /** Моменты месяца: идёт, его последняя секунда и первая минута следующего. */
  function times(month: string): { inside: Date; last: Date; closeAt: Date } {
    const { endsAt } = monthBounds(month);
    return { inside: new Date(endsAt.getTime() - 10 * DAY), last: new Date(endsAt.getTime() - 1_000), closeAt: new Date(endsAt.getTime() + 20_000) };
  }

  /** Игрок, дошедший до ступени `tier`: очки по 100 на ступень. */
  async function reached(tier: number, month: string, extraPoints = 0): Promise<AccountRef> {
    const me = await person();
    await passRepository.addPoints(me.accountId, month, tier * 100 + extraPoints, times(month).inside);
    return me;
  }

  /** Оплаченный VIP: период, начинающийся в `from` и идущий `days` суток. */
  async function vipPeriod(accountId: string, from: Date, days: number): Promise<void> {
    const purchaseId = randomUUID();
    await prisma.purchase.create({
      data: {
        purchaseId,
        accountId,
        product: "vip",
        sku: "vip_month",
        priceStars: 200,
        chargedStars: 200,
        mode: "live",
        status: "paid",
        telegramChargeId: `charge-${purchaseId}`,
        invoicedAt: from,
        paidAt: from,
      },
    });
    await vipRepository.addPeriod({ purchaseId, subscriptionId: purchaseId, accountId, paidAt: from, periodSec: days * 86_400, at: from });
  }

  function replica(options: { redis?: LockRedis; limits?: Partial<PassCloseLimits>; wallet?: WalletService; notifications?: NotificationsService } = {}): PassCloseService {
    return new PassCloseService(
      options.redis ?? asLock(realRedis ?? new FakeLockRedis()),
      closeRepository,
      passRepository,
      options.wallet ?? wallet,
      options.notifications ?? notifications,
      vipRepository,
      settings,
      { ...FAST, ...options.limits },
    );
  }

  /** Сумма награды ленты по умолчанию за ступени `from…to` по ресурсам. */
  function ribbonSum(lane: PassLane, to: number, from = 1): Record<string, { count: number; amount: number }> {
    const sum: Record<string, { count: number; amount: number }> = {};
    for (const tier of DEFAULT_RIBBON.slice(from - 1, to)) {
      for (const line of rewardLines(tier[lane])) {
        const entry = sum[line.resource] ?? { count: 0, amount: 0 };
        sum[line.resource] = { count: entry.count + 1, amount: entry.amount + line.amount };
      }
    }
    return sum;
  }

  /** Что кошелёк записал игроку за месяц пасса: по ресурсам число строк и сумма. */
  async function ledger(accountId: string, month: string): Promise<Record<string, { count: number; amount: number }>> {
    const rows = await prisma.$queryRaw<{ resource: string; count: number; amount: number }[]>`
      SELECT resource::text AS resource, count(*)::int AS count, sum(amount)::int AS amount FROM wallet_entry
      WHERE account_id = ${accountId}::uuid AND reason = 'pass_reward' AND source LIKE ${`pass:${month}:%`}
      GROUP BY resource`;
    return Object.fromEntries(rows.map((row) => [row.resource, { count: row.count, amount: row.amount }]));
  }

  async function journal(accountId: string, month: string): Promise<{ tier: number; lane: string }[]> {
    return await prisma.$queryRaw<{ tier: number; lane: string }[]>`SELECT tier::int AS tier, lane FROM pass_claim WHERE account_id = ${accountId}::uuid AND month_key = ${month} ORDER BY lane, tier`;
  }

  const upTo = (lane: PassLane, last: number, first = 1) => Array.from({ length: last - first + 1 }, (_, index) => ({ tier: first + index, lane }));

  async function boosts(accountId: string): Promise<Record<string, number>> {
    const rows = await prisma.$queryRaw<{ boost_id: string; count: number }[]>`SELECT boost_id, count FROM boost_credit WHERE account_id = ${accountId}::uuid`;
    return Object.fromEntries(rows.map((row) => [row.boost_id, row.count]));
  }

  async function closeRows(month: string): Promise<number> {
    const rows = await prisma.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM pass_close WHERE month_key = ${month}`;
    return rows[0]?.count ?? 0;
  }

  async function notices(accountId: string): Promise<{ month: string; rewards: number }[]> {
    const rows = await prisma.$queryRaw<{ payload: { month: string; rewards: number } }[]>`SELECT payload FROM notification WHERE account_id = ${accountId}::uuid AND kind = 'pass_closed'`;
    return rows.map((row) => row.payload);
  }

  function logged(spy: { mock: { calls: unknown[][] } }, event: string): Record<string, unknown>[] {
    return spy.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes(`"${event}"`))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, DATABASE_URL, ...(REDIS_URL === "" ? {} : { REDIS_URL }) } as NodeJS.ProcessEnv);
    prisma = testPrisma(DATABASE_URL, 16);
    if (REDIS_URL !== "") {
      realRedis = createRedis(config);
      await realRedis.connect();
      await realRedis.del(PASS_CLOSE_LOCK_KEY);
    }
    accounts = new PrismaAccountRepository(prisma);
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository()));
    notifications = new NotificationsService(new PrismaNotificationsRepository(prisma));
    passRepository = new PrismaBattlePassRepository(prisma);
    closeRepository = new PrismaPassCloseRepository(prisma);
    vipRepository = new PrismaVipRepository(prisma);
    pass = new BattlePassService(passRepository, wallet, { activeAt: (accountId) => Promise.resolve(vipNow.has(accountId)) }, settings);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    settings.set(SETTINGS.passPointsPerTier.key, 100);
  });

  afterAll(async () => {
    for (const month of usedMonths) await wipeMonth(month);
    await prisma.$disconnect();
    if (realRedis !== null) {
      await realRedis.del(PASS_CLOSE_LOCK_KEY);
      await closeRedis(realRedis);
    }
  });

  describe("кому что выдаётся", () => {
    it("игрок на 12-й ступени, забравший 1…5 бесплатной, получает 6…12 — всё по одному разу", async () => {
      const month = await freeMonth();
      const { inside, closeAt } = times(month);
      const me = await reached(12, month);
      for (let tier = 1; tier <= 5; tier++) await pass.claim(me, tier, "free", inside);
      expect(await journal(me.accountId, month)).toEqual(upTo("free", 5));

      const closed = await replica().closeDue(closeAt);

      expect(forMonth(closed, month)).toEqual({ monthKey: month, accounts: 1, rewards: 7 });
      expect(await journal(me.accountId, month)).toEqual(upTo("free", 12));
      expect(await ledger(me.accountId, month)).toEqual(ribbonSum("free", 12));
      // подарок-буст 5-й ступени выдан ручным забором, закрытие его не удвоило
      expect(await boosts(me.accountId)).toEqual({ fury: 1 });
    }, RACE_TIMEOUT_MS);

    it("VIP был три дня в месяце — выдана и VIP-лента 1…12; без VIP VIP-ленты нет", async () => {
      const month = await freeMonth();
      const { startsAt } = monthBounds(month);
      const { closeAt } = times(month);
      const withVip = await reached(12, month);
      const without = await reached(12, month);
      await vipPeriod(withVip.accountId, new Date(startsAt.getTime() + 9 * DAY), 3);

      await replica().closeDue(closeAt);

      expect(await journal(withVip.accountId, month)).toEqual([...upTo("free", 12), ...upTo("vip", 12)]);
      expect(await journal(without.accountId, month)).toEqual(upTo("free", 12));
      const free = ribbonSum("free", 12);
      const vip = ribbonSum("vip", 12);
      const both: Record<string, { count: number; amount: number }> = {};
      for (const resource of new Set([...Object.keys(free), ...Object.keys(vip)])) {
        both[resource] = { count: (free[resource]?.count ?? 0) + (vip[resource]?.count ?? 0), amount: (free[resource]?.amount ?? 0) + (vip[resource]?.amount ?? 0) };
      }
      expect(await ledger(withVip.accountId, month)).toEqual(both);
      expect(await ledger(without.accountId, month)).toEqual(free);
    }, RACE_TIMEOUT_MS);

    it("VIP на границах месяца: захватил первый или последний день — есть лента; кончился к началу или начался с концом — нет", async () => {
      const month = await freeMonth();
      const { startsAt, endsAt } = monthBounds(month);
      const { closeAt } = times(month);
      const players = {
        lastDay: await reached(2, month),
        firstDay: await reached(2, month),
        endedAtStart: await reached(2, month),
        startedAtEnd: await reached(2, month),
        bought: await reached(2, month),
      };
      await vipPeriod(players.firstDay.accountId, new Date(startsAt.getTime() - 29 * DAY), 30);
      await vipPeriod(players.lastDay.accountId, new Date(endsAt.getTime() - 3_600_000), 5);
      await vipPeriod(players.endedAtStart.accountId, new Date(startsAt.getTime() - 30 * DAY), 30);
      await vipPeriod(players.startedAtEnd.accountId, endsAt, 30);
      // купил VIP уже после закрытия месяца: за этот месяц не платил
      await vipPeriod(players.bought.accountId, new Date(endsAt.getTime() + DAY), 30);

      await replica().closeDue(closeAt);

      expect((await journal(players.firstDay.accountId, month)).filter((row) => row.lane === "vip")).toHaveLength(2);
      expect((await journal(players.lastDay.accountId, month)).filter((row) => row.lane === "vip")).toHaveLength(2);
      for (const none of [players.endedAtStart, players.startedAtEnd, players.bought]) {
        expect((await journal(none.accountId, month)).filter((row) => row.lane === "vip")).toEqual([]);
      }
    }, RACE_TIMEOUT_MS);

    it("шаг ступени берётся из настройки на момент закрытия; игрок без ступени ничего не получает", async () => {
      const month = await freeMonth();
      const { closeAt } = times(month);
      const half = await person();
      await passRepository.addPoints(half.accountId, month, 250, times(month).inside);
      const nothing = await person();
      await passRepository.addPoints(nothing.accountId, month, 99, times(month).inside);
      settings.set(SETTINGS.passPointsPerTier.key, 50);

      await replica().closeDue(closeAt);

      expect(await journal(half.accountId, month)).toEqual(upTo("free", 5));
      expect(await journal(nothing.accountId, month)).toEqual([]);
      expect(await ledger(nothing.accountId, month)).toEqual({});
    }, RACE_TIMEOUT_MS);

    it("лента месяца из базы заменяет ленту по умолчанию и при закрытии", async () => {
      const month = await freeMonth();
      const { closeAt } = times(month);
      const custom = DEFAULT_RIBBON.map((tier) => (tier.tier === 1 ? { ...tier, free: { coins: 777 } satisfies PassReward } : tier));
      await prisma.$executeRaw`INSERT INTO pass_season (month_key, tiers, published_at) VALUES (${month}, ${JSON.stringify(custom)}::jsonb, now())`;
      const me = await reached(1, month);

      await replica().closeDue(closeAt);

      expect(await ledger(me.accountId, month)).toEqual({ coins: { count: 1, amount: 777 } });
    }, RACE_TIMEOUT_MS);

    it("бусты-подарки ступеней 5, 15 и 25 выдаются по одному, а повторное закрытие их не удваивает", async () => {
      const month = await freeMonth();
      const { closeAt } = times(month);
      const me = await reached(30, month);

      await replica().closeDue(closeAt);
      await replica().closeDue(closeAt);

      expect(await boosts(me.accountId)).toEqual({ fury: 1, aegis: 1, bulwark: 1 });
    }, RACE_TIMEOUT_MS);

    it("суточный потолок кошелька не урезает выдачу: 30 ступеней обеих лент ложатся целиком", async () => {
      const month = await freeMonth();
      const { startsAt } = monthBounds(month);
      const { closeAt } = times(month);
      const me = await reached(30, month, 4_000);
      await vipPeriod(me.accountId, new Date(startsAt.getTime() + DAY), 2);

      await replica().closeDue(closeAt);

      const free = ribbonSum("free", 30);
      const vip = ribbonSum("vip", 30);
      const stored = await ledger(me.accountId, month);
      for (const resource of new Set([...Object.keys(free), ...Object.keys(vip)])) {
        expect(stored[resource]?.amount, resource).toBe((free[resource]?.amount ?? 0) + (vip[resource]?.amount ?? 0));
      }
      expect(await journal(me.accountId, month)).toEqual([...upTo("free", 30), ...upTo("vip", 30)]);
    }, RACE_TIMEOUT_MS);
  });

  describe("какие месяцы закрываются", () => {
    it("идущий месяц не трогается, прошедший закрывается, повтор ничего не выдаёт и не пишет", async () => {
      const month = await freeMonth();
      const { inside, closeAt } = times(month);
      const me = await reached(3, month);

      expect(forMonth(await replica().closeDue(inside), month)).toBeUndefined();
      expect(await journal(me.accountId, month)).toEqual([]);
      expect(await closeRows(month)).toBe(0);

      expect(forMonth(await replica().closeDue(closeAt), month)).toEqual({ monthKey: month, accounts: 1, rewards: 3 });
      const before = await ledger(me.accountId, month);
      expect(await closeRows(month)).toBe(1);

      expect(await replica().closeDue(new Date(closeAt.getTime() + 60_000))).toEqual([]);
      expect(await ledger(me.accountId, month)).toEqual(before);
      expect(await closeRows(month)).toBe(1);
      expect(await notices(me.accountId)).toHaveLength(1);
    }, RACE_TIMEOUT_MS);

    it("месяц без игроков закрывается пустой строкой", async () => {
      const month = await freeMonth();
      expect(forMonth(await replica().closeDue(times(month).closeAt), month)).toEqual({ monthKey: month, accounts: 0, rewards: 0 });
      expect(await closeRows(month)).toBe(1);
    }, RACE_TIMEOUT_MS);

    it("пропущенные месяцы закрываются по порядку, но не старше окна догона", async () => {
      const month = await freeMonth();
      const older = shift(month, -1);
      const oldest = shift(month, -2);
      const tooOld = shift(month, -PASS_CLOSE_LIMITS.lookbackMonths);
      const late = await reached(2, month);
      const old = await reached(2, older);
      const forgotten = await reached(2, tooOld);

      const closed = await replica().closeDue(times(month).closeAt);

      expect(closed?.map((item) => item.monthKey)).toEqual([oldest, older, month]);
      expect(await journal(old.accountId, older)).toEqual(upTo("free", 2));
      expect(await journal(late.accountId, month)).toEqual(upTo("free", 2));
      expect(await journal(forgotten.accountId, tooOld)).toEqual([]);
      expect(await closeRows(tooOld)).toBe(0);
    }, RACE_TIMEOUT_MS);

    it("больше пачки: игроки из всех пачек получают, ни один не пропущен и не повторён", async () => {
      const month = await freeMonth();
      const players = await Promise.all(Array.from({ length: 7 }, () => reached(2, month)));

      const closed = await replica({ limits: { batch: 3 } }).closeDue(times(month).closeAt);

      expect(forMonth(closed, month)).toEqual({ monthKey: month, accounts: 7, rewards: 14 });
      for (const player of players) expect(await journal(player.accountId, month)).toEqual(upTo("free", 2));
    }, RACE_TIMEOUT_MS);
  });

  describe("две реплики и повторы", () => {
    it("лок общий: второе задание, пришедшее разом, уходит ни с чем, выдача одна", async () => {
      const month = await freeMonth();
      const me = await reached(12, month);
      const shared = new FakeLockRedis();

      const results = await Promise.all([replica({ redis: asLock(shared) }).closeDue(times(month).closeAt), replica({ redis: asLock(shared) }).closeDue(times(month).closeAt)]);

      expect(results.filter((result) => result === null)).toHaveLength(1);
      const done = results.filter((result) => result !== null);
      expect(done).toHaveLength(1);
      expect(forMonth(done[0] ?? null, month)).toEqual({ monthKey: month, accounts: 1, rewards: 12 });
      expect(await ledger(me.accountId, month)).toEqual(ribbonSum("free", 12));
      expect(await closeRows(month)).toBe(1);
    }, RACE_TIMEOUT_MS);

    it("настоящий Redis: замок занят — задание уходит ни с чем и ничего не выдаёт; после снятия закрывает", async () => {
      if (realRedis === null) return;
      const month = await freeMonth();
      const me = await reached(3, month);
      await realRedis.set(PASS_CLOSE_LOCK_KEY, "чужой-токен", "PX", 60_000);

      expect(await replica().closeDue(times(month).closeAt)).toBeNull();
      expect(await journal(me.accountId, month)).toEqual([]);
      // чужой замок не снимается
      expect(await realRedis.get(PASS_CLOSE_LOCK_KEY)).toBe("чужой-токен");

      await realRedis.del(PASS_CLOSE_LOCK_KEY);
      expect(forMonth(await replica().closeDue(times(month).closeAt), month)).toBeDefined();
      expect(await realRedis.exists(PASS_CLOSE_LOCK_KEY)).toBe(0);
    }, RACE_TIMEOUT_MS);

    it("замок потерян (у каждой реплики свой): обе идут разом, но каждая награда, подарок и уведомление — один раз", async () => {
      const month = await freeMonth();
      const players = await Promise.all(Array.from({ length: 4 }, () => reached(15, month)));

      const [first, second] = await Promise.all([replica({ redis: asLock(new FakeLockRedis()) }).closeDue(times(month).closeAt), replica({ redis: asLock(new FakeLockRedis()) }).closeDue(times(month).closeAt)]);

      // обе довели месяц до конца: метка закрытия вставилась у одной
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(await closeRows(month)).toBe(1);
      for (const player of players) {
        expect(await ledger(player.accountId, month)).toEqual(ribbonSum("free", 15));
        expect(await journal(player.accountId, month)).toEqual(upTo("free", 15));
        expect(await boosts(player.accountId)).toEqual({ fury: 1, aegis: 1 });
        expect(await notices(player.accountId)).toEqual([{ month, rewards: 15 }]);
      }
    }, RACE_TIMEOUT_MS);

    it("ручной забор в последнюю секунду месяца и закрытие разом: каждая награда ложится один раз", async () => {
      const month = await freeMonth();
      const { last, closeAt } = times(month);
      const me = await reached(12, month);

      const results = await Promise.allSettled([replica().closeDue(closeAt), ...Array.from({ length: 12 }, (_, index) => pass.claim(me, index + 1, "free", last))]);

      expect(results[0]?.status).toBe("fulfilled");
      for (const rejected of results.filter((result): result is PromiseRejectedResult => result.status === "rejected")) expect(rejected.reason).toMatchObject({ code: "pass_already_claimed" });
      expect(await ledger(me.accountId, month)).toEqual(ribbonSum("free", 12));
      expect(await journal(me.accountId, month)).toEqual(upTo("free", 12));
      expect(await boosts(me.accountId)).toEqual({ fury: 1 });
    }, RACE_TIMEOUT_MS);

    it("потерянный посреди прохода замок останавливает проход: месяц не закрыт, а следующий проход выдаёт остаток без двойных", async () => {
      const month = await freeMonth();
      const players = await Promise.all(Array.from({ length: 6 }, () => reached(4, month)));
      const flaky = new FakeLockRedis();
      flaky.dropAtRenewal = 2;
      const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

      const stopped = await replica({ redis: asLock(flaky), limits: { batch: 2, lockRenewEveryMs: 0 } }).closeDue(times(month).closeAt);

      expect(stopped).toBeNull();
      expect(await closeRows(month)).toBe(0);
      expect(logged(warn, "pass_close_lock_lost")).toHaveLength(1);

      expect(forMonth(await replica().closeDue(times(month).closeAt), month)).toBeDefined();
      for (const player of players) {
        expect(await ledger(player.accountId, month)).toEqual(ribbonSum("free", 4));
        expect(await journal(player.accountId, month)).toEqual(upTo("free", 4));
        expect(await notices(player.accountId)).toHaveLength(1);
      }
    }, RACE_TIMEOUT_MS);
  });

  describe("сбои", () => {
    it("процесс упал между кошельком и журналом: кошелёк по ключу не удваивается, журнал и подарок дописываются", async () => {
      const month = await freeMonth();
      const me = await reached(5, month);
      const reward = DEFAULT_RIBBON[4]?.free;
      expect(reward?.boost).toBeDefined();
      for (const line of rewardLines(reward ?? {})) {
        await wallet.grant({
          accountId: me.accountId,
          resource: line.resource,
          amount: line.amount,
          reason: "pass_reward",
          source: `pass:${month}:5:free`,
          idempotencyKey: passGrantKey(month, 5, "free", me.accountId, line.resource),
          at: times(month).last,
        });
      }
      expect(await journal(me.accountId, month)).toEqual([]);

      await replica().closeDue(times(month).closeAt);

      expect(await ledger(me.accountId, month)).toEqual(ribbonSum("free", 5));
      expect(await journal(me.accountId, month)).toEqual(upTo("free", 5));
      expect(await boosts(me.accountId)).toEqual({ fury: 1 });
    }, RACE_TIMEOUT_MS);

    it("сбой кошелька посреди пачки: пачка повторяется, месяц закрыт, двойных выдач нет", async () => {
      const month = await freeMonth();
      const players = await Promise.all(Array.from({ length: 5 }, () => reached(6, month)));
      const original = wallet.grant.bind(wallet);
      let calls = 0;
      vi.spyOn(wallet, "grant").mockImplementation(async (input) => {
        calls++;
        if (calls === 9) throw new Error("кошелёк недоступен");
        return await original(input);
      });

      const closed = await replica({ limits: { batch: 3 } }).closeDue(times(month).closeAt);

      expect(forMonth(closed, month)).toEqual({ monthKey: month, accounts: 5, rewards: 30 });
      expect(await closeRows(month)).toBe(1);
      for (const player of players) {
        expect(await ledger(player.accountId, month)).toEqual(ribbonSum("free", 6));
        expect(await journal(player.accountId, month)).toEqual(upTo("free", 6));
        expect(await notices(player.accountId)).toEqual([{ month, rewards: 6 }]);
      }
    }, RACE_TIMEOUT_MS);

    it("стойкий сбой у одного игрока: остальные оплачены, месяц не закрыт; после починки — догон без двойных выдач", async () => {
      const month = await freeMonth();
      const bad = await reached(4, month);
      const good = await Promise.all(Array.from({ length: 3 }, () => reached(4, month)));
      const original = wallet.grant.bind(wallet);
      const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      const broken = vi.spyOn(wallet, "grant").mockImplementation(async (input) => {
        if (input.accountId === bad.accountId) throw new Error("кошелёк недоступен");
        return await original(input);
      });

      const closed = await replica({ limits: { batch: 2 } }).closeDue(times(month).closeAt);

      expect(forMonth(closed, month)).toBeUndefined();
      expect(await closeRows(month)).toBe(0);
      expect(logged(warn, "pass_close_incomplete")).toHaveLength(1);
      for (const player of good) expect(await ledger(player.accountId, month)).toEqual(ribbonSum("free", 4));
      expect(await notices(bad.accountId)).toEqual([]);

      broken.mockRestore();
      const healed = await replica().closeDue(times(month).closeAt);

      expect(forMonth(healed, month)).toBeDefined();
      expect(await closeRows(month)).toBe(1);
      for (const player of [bad, ...good]) {
        expect(await ledger(player.accountId, month)).toEqual(ribbonSum("free", 4));
        expect(await journal(player.accountId, month)).toEqual(upTo("free", 4));
        expect(await notices(player.accountId)).toEqual([{ month, rewards: 4 }]);
      }
    }, RACE_TIMEOUT_MS);

    it("сбой подарка-буста: журнал и подарок откатываются вместе, повтор выдаёт их целиком", async () => {
      const month = await freeMonth();
      const me = await reached(5, month);
      vi.spyOn(passRepository, "claim").mockRejectedValueOnce(new Error("база недоступна")).mockRejectedValueOnce(new Error("база недоступна")).mockRejectedValueOnce(new Error("база недоступна"));

      expect(forMonth(await replica({ limits: { attempts: 3 } }).closeDue(times(month).closeAt), month)).toBeUndefined();
      expect(await boosts(me.accountId)).toEqual({});
      expect(await closeRows(month)).toBe(0);

      vi.restoreAllMocks();
      await replica().closeDue(times(month).closeAt);
      expect(await boosts(me.accountId)).toEqual({ fury: 1 });
      expect(await journal(me.accountId, month)).toEqual(upTo("free", 5));
    }, RACE_TIMEOUT_MS);
  });

  describe("уведомление", () => {
    it("одно на игрока с числом зачисленных наград; без наград — нет уведомления; повтор закрытия не добавляет", async () => {
      const month = await freeMonth();
      const { startsAt } = monthBounds(month);
      const { inside, closeAt } = times(month);
      const some = await reached(12, month);
      for (let tier = 1; tier <= 5; tier++) await pass.claim(some, tier, "free", inside);
      const fresh = await reached(3, month);
      const noTier = await person();
      await passRepository.addPoints(noTier.accountId, month, 50, inside);
      const allDone = await reached(2, month);
      for (let tier = 1; tier <= 2; tier++) await pass.claim(allDone, tier, "free", inside);
      const vip = await reached(2, month);
      await vipPeriod(vip.accountId, new Date(startsAt.getTime() + 2 * DAY), 3);

      await replica().closeDue(closeAt);
      await replica().closeDue(closeAt);

      expect(await notices(some.accountId)).toEqual([{ month, rewards: 7 }]);
      expect(await notices(fresh.accountId)).toEqual([{ month, rewards: 3 }]);
      expect(await notices(vip.accountId)).toEqual([{ month, rewards: 4 }]);
      expect(await notices(noTier.accountId)).toEqual([]);
      expect(await notices(allDone.accountId)).toEqual([]);
    }, RACE_TIMEOUT_MS);

    it("сбой уведомления не мешает выдаче: награды зачислены, в лог — предупреждение", async () => {
      const month = await freeMonth();
      const me = await reached(3, month);
      const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      const broken = new NotificationsService(new PrismaNotificationsRepository(prisma));
      vi.spyOn(broken, "deliver").mockRejectedValue(new Error("лента недоступна"));

      const closed = await replica({ notifications: broken }).closeDue(times(month).closeAt);

      expect(forMonth(closed, month)).toEqual({ monthKey: month, accounts: 1, rewards: 3 });
      expect(await ledger(me.accountId, month)).toEqual(ribbonSum("free", 3));
      expect(logged(warn, "pass_close_notify_failed").length).toBeGreaterThan(0);
    }, RACE_TIMEOUT_MS);
  });

  describe("аналитика", () => {
    it("pass_closed — один раз у закрывшего месяц; pass_reward_claimed с source close — по награде", async () => {
      const month = await freeMonth();
      const me = await reached(3, month);
      const other = await reached(2, month);
      const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);

      await replica().closeDue(times(month).closeAt);
      await replica().closeDue(times(month).closeAt);

      expect(logged(log, "pass_closed")).toEqual([expect.objectContaining({ module: "battle-pass", event: "pass_closed", month, accounts: 2, rewards: 5 })]);
      const claimed = logged(log, "pass_reward_claimed").filter((line) => line.month === month);
      expect(claimed).toHaveLength(5);
      expect(claimed.every((line) => line.source === "close" && line.module === "battle-pass")).toBe(true);
      expect(claimed.filter((line) => line.accountId === me.accountId).map((line) => line.tier)).toEqual([1, 2, 3]);
      expect(claimed.filter((line) => line.accountId === other.accountId)).toHaveLength(2);
    }, RACE_TIMEOUT_MS);
  });

  describe("схема базы", () => {
    it("метка закрытия: ключ месяца в формате, один раз на месяц", async () => {
      const month = await freeMonth();
      await prisma.$executeRaw`INSERT INTO pass_close (month_key, closed_at) VALUES (${month}, now())`;
      await expect(prisma.$executeRaw`INSERT INTO pass_close (month_key, closed_at) VALUES (${month}, now())`).rejects.toThrow();
      await expect(prisma.$executeRaw`INSERT INTO pass_close (month_key, closed_at) VALUES ('2026-13', now())`).rejects.toThrow();
      expect(await closeRepository.markClosed(month, new Date())).toBe(false);
      expect(await closeRepository.markClosed(shift(month, 1), new Date())).toBe(true);
    });
  });
});

describe("уведомление pass_closed", () => {
  it("вид принимает месяц и число наград, остальное отвергает", () => {
    const schema = NOTIFICATION_KINDS.pass_closed;
    expect(schema.safeParse({ month: "2026-10", rewards: 7 }).success).toBe(true);
    expect(schema.safeParse({ month: "2026-10", rewards: 60 }).success).toBe(true);
    expect(schema.safeParse({ month: "2026-10", rewards: 0 }).success).toBe(false);
    expect(schema.safeParse({ month: "2026-13", rewards: 3 }).success).toBe(false);
    expect(schema.safeParse({ month: "октябрь", rewards: 3 }).success).toBe(false);
    expect(schema.safeParse({ month: "2026-10", rewards: 3.5 }).success).toBe(false);
    expect(schema.safeParse({ month: "2026-10" }).success).toBe(false);
  });

  it("текст бота: месяц в родительном падеже, число наград со склонением, кнопка в игру с параметром вида", () => {
    const launch = (startParam: string): string => `https://t.me/rubezh_bot/app?startapp=${startParam}`;
    const texts = [1, 2, 5, 11, 21, 22, 25].map((rewards) => botMessageOf("pass_closed", { month: "2026-10", rewards }, launch)?.text);
    expect(texts).toEqual([
      "Пасс октября закрыт: 1 награда зачислена на счёт.",
      "Пасс октября закрыт: 2 награды зачислены на счёт.",
      "Пасс октября закрыт: 5 наград зачислено на счёт.",
      "Пасс октября закрыт: 11 наград зачислено на счёт.",
      "Пасс октября закрыт: 21 награда зачислена на счёт.",
      "Пасс октября закрыт: 22 награды зачислены на счёт.",
      "Пасс октября закрыт: 25 наград зачислено на счёт.",
    ]);
    expect(botMessageOf("pass_closed", { month: "2026-01", rewards: 3 }, launch)?.text).toContain("Пасс января");
    expect(botMessageOf("pass_closed", { month: "2026-12", rewards: 3 }, launch)?.text).toContain("Пасс декабря");
    expect(botMessageOf("pass_closed", { month: "2026-10", rewards: 3 }, launch)?.button).toEqual({ text: "▶ Открыть игру", url: launch("n-pass_closed") });
    expect(botMessageOf("pass_closed", { month: "2026-10", rewards: 3 }, () => null)?.button).toBeNull();
  });

  it("данные не по схеме: бот молчит", () => {
    expect(botMessageOf("pass_closed", { month: "2026-10", rewards: 0 }, () => null)).toBeNull();
    expect(botMessageOf("pass_closed", { month: "когда-то" }, () => null)).toBeNull();
    expect(botMessageOf("pass_closed", null, () => null)).toBeNull();
  });
});
