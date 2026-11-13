import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { BOOST_REFUND } from "../src/modules/boosts/boosts-limits.js";
import { BoostsRefunder } from "../src/modules/boosts/boosts-refunder.js";
import { PrismaBoostsRepository } from "../src/modules/boosts/boosts.repository.js";
import { BoostsService } from "../src/modules/boosts/boosts.service.js";
import { PrismaNotificationsRepository } from "../src/modules/notifications/notifications.repository.js";
import { NotificationsService } from "../src/modules/notifications/notifications.service.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { PrismaRunsRepository } from "../src/modules/runs/runs.repository.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import type { WalletResource } from "../src/modules/wallet/wallet-types.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Бусты-подарки пасса на живом Postgres (docs/17-testing-strategy.md §4.2; адрес
 * — TEST_DATABASE_URL, без него пропуск; tasks/T-0312). Подарок тратит
 * включение буста на забег: `count − 1` вместо списания монет или самоцветов,
 * в журнале активации — `paid_with: "credit"`; забег, который не начался,
 * получает назад подарок, а не деньги. Всё это — в одной транзакции с покупкой
 * остального набора, поэтому проверяется под гонкой и откатом, а не по
 * одиночному вызову.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const RACE_TIMEOUT_MS = 30_000;

describe.skipIf(DATABASE_URL === "")("бусты-подарки на живом Postgres", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let wallet: WalletService;
  let repository: PrismaBoostsRepository;
  let runs: PrismaRunsRepository;
  let boosts: BoostsService;

  async function account(): Promise<string> {
    const created = await accounts.upsert({ platform: "telegram", platformUserId: String(660_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Подарок", username: null }, Date.now());
    return created.accountId;
  }

  async function fund(accountId: string, resource: WalletResource, amount: number): Promise<void> {
    await wallet.grant({ accountId, resource, amount, reason: resource === "coins" ? "run_reward" : "level_reward", idempotencyKey: `test:${randomUUID()}` });
  }

  /** Подарки пасса игроку: строка `boost_credit`, как её заводит забор награды. */
  async function gift(accountId: string, boostId: string, count: number): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO boost_credit (account_id, boost_id, count) VALUES (${accountId}::uuid, ${boostId}, ${count})
      ON CONFLICT (account_id, boost_id) DO UPDATE SET count = EXCLUDED.count`;
  }

  async function credits(accountId: string): Promise<Record<string, number>> {
    const rows = await prisma.$queryRaw<{ boost_id: string; count: number }[]>`SELECT boost_id, count FROM boost_credit WHERE account_id = ${accountId}::uuid`;
    return Object.fromEntries(rows.map((row) => [row.boost_id, row.count]));
  }

  async function boostEntries(accountId: string): Promise<number> {
    const rows = await prisma.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM wallet_entry WHERE account_id = ${accountId}::uuid AND reason IN ('boost', 'boost_refund')`;
    return rows[0]?.count ?? 0;
  }

  const balance = async (accountId: string, resource: WalletResource) => (await wallet.balances(accountId))[resource];
  const start = (accountId: string, runId: string) => runs.start({ runId, accountId, difficulty: "normal", startingWeaponId: "spark", contentHash: "abc", startedAt: new Date() });

  beforeAll(() => {
    config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv);
    prisma = testPrisma(DATABASE_URL, 20);
    accounts = new PrismaAccountRepository(prisma);
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository()));
    repository = new PrismaBoostsRepository(prisma);
    runs = new PrismaRunsRepository(prisma);
    boosts = new BoostsService(repository, wallet, new NotificationsService(new PrismaNotificationsRepository(prisma)));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("включение буста", () => {
    it("подарок есть — буст включён без списания, подарок на единицу меньше, в журнале «credit»", async () => {
      const id = await account();
      await fund(id, "coins", 1_000);
      await gift(id, "fury", 2);
      const runId = randomUUID();

      const view = await boosts.activate(id, runId, ["fury"]);

      expect(view).toMatchObject({ runId, boosts: ["fury"], paidWith: { fury: "credit" } });
      expect(view.cost).toEqual({});
      expect(await balance(id, "coins")).toBe(1_000);
      expect(await credits(id)).toEqual({ fury: 1 });
      expect(await boostEntries(id)).toBe(0);
      const row = await repository.byRun(runId);
      expect(row).toMatchObject({ boosts: ["fury"], cost: {}, paidWith: { fury: "credit" } });
    });

    it("подарок на самоцветный буст: самоцветы не списываются", async () => {
      const id = await account();
      await fund(id, "gems", 10);
      await gift(id, "head_start", 1);

      await boosts.activate(id, randomUUID(), ["head_start"]);

      expect(await balance(id, "gems")).toBe(10);
      expect(await credits(id)).toEqual({ head_start: 0 });
    });

    it("подарка нет — деньги, как раньше; подарок другого буста не трогается", async () => {
      const id = await account();
      await fund(id, "coins", 1_000);
      await gift(id, "aegis", 1);

      const view = await boosts.activate(id, randomUUID(), ["fury"]);

      expect(view).toMatchObject({ cost: { coins: 150 }, paidWith: { fury: "coins" } });
      expect(await balance(id, "coins")).toBe(850);
      expect(await credits(id)).toEqual({ aegis: 1 });
    });

    it("подарок исчерпан (строка с нулём) — снова деньги, в минус не уходит", async () => {
      const id = await account();
      await fund(id, "coins", 1_000);
      await gift(id, "fury", 0);

      await boosts.activate(id, randomUUID(), ["fury"]);

      expect(await balance(id, "coins")).toBe(850);
      expect(await credits(id)).toEqual({ fury: 0 });
    });

    it("набор из подарочного и купленного: подарок −1, списано только за купленное", async () => {
      const id = await account();
      await fund(id, "coins", 1_000);
      await fund(id, "gems", 10);
      await gift(id, "fury", 1);

      const view = await boosts.activate(id, randomUUID(), ["fury", "head_start", "aegis"]);

      expect(view).toMatchObject({ cost: { coins: 120, gems: 4 }, paidWith: { fury: "credit", head_start: "gems", aegis: "coins" } });
      expect(await balance(id, "coins")).toBe(880);
      expect(await balance(id, "gems")).toBe(6);
      expect(await credits(id)).toEqual({ fury: 0 });
    });

    it("повтор того же забега — даже десять разом — второй подарок не тратит и ничего не списывает", async () => {
      const id = await account();
      await fund(id, "coins", 1_000);
      await gift(id, "fury", 3);
      const runId = randomUUID();

      const results = await Promise.all(Array.from({ length: 10 }, () => boosts.activate(id, runId, ["fury"])));

      expect(results.every((result) => result.paidWith.fury === "credit")).toBe(true);
      expect(await credits(id)).toEqual({ fury: 2 });
      expect(await balance(id, "coins")).toBe(1_000);
      // Повтор с другим набором — прежний набор: покупка на забег одна.
      expect((await boosts.activate(id, runId, ["lure"])).boosts).toEqual(["fury"]);
      expect(await credits(id)).toEqual({ fury: 2 });
    }, RACE_TIMEOUT_MS);

    it("последний подарок и два забега разом: один забег берёт подарок, другой платит; в минус не уходит", async () => {
      const id = await account();
      await fund(id, "coins", 1_000);
      await gift(id, "fury", 1);

      const [first, second] = await Promise.all([boosts.activate(id, randomUUID(), ["fury"]), boosts.activate(id, randomUUID(), ["fury"])]);

      expect([first.paidWith.fury, second.paidWith.fury].sort()).toEqual(["coins", "credit"]);
      expect(await credits(id)).toEqual({ fury: 0 });
      expect(await balance(id, "coins")).toBe(850);
    }, RACE_TIMEOUT_MS);

    it("наборы в разном порядке разом (взаимная блокировка строк подарков невозможна): все активации проходят", async () => {
      const id = await account();
      await fund(id, "coins", 5_000);
      await gift(id, "fury", 5);
      await gift(id, "aegis", 5);

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, index) => boosts.activate(id, randomUUID(), index % 2 === 0 ? ["fury", "aegis"] : ["aegis", "fury"])),
      );

      expect(results.filter((result) => result.status === "rejected")).toEqual([]);
      expect(await credits(id)).toEqual({ fury: 0, aegis: 0 });
    }, RACE_TIMEOUT_MS);

    it("не хватило на купленную часть — откат целиком: подарок цел, забег не заведён", async () => {
      const id = await account();
      await fund(id, "coins", 1_000);
      await gift(id, "fury", 1);
      const runId = randomUUID();

      await expect(boosts.activate(id, runId, ["fury", "insight"])).rejects.toMatchObject({ code: "insufficient_funds", resource: "gems" });

      expect(await credits(id)).toEqual({ fury: 1 });
      expect(await balance(id, "coins")).toBe(1_000);
      expect(await repository.byRun(runId)).toBeNull();
    });

    it("начатый и чужой забеги подарок не тратят", async () => {
      const owner = await account();
      const stranger = await account();
      await gift(owner, "fury", 1);
      await gift(stranger, "fury", 1);
      const runId = randomUUID();
      await boosts.activate(owner, runId, ["fury"]);
      const started = randomUUID();
      await start(owner, started);
      await gift(owner, "aegis", 1);

      await expect(boosts.activate(stranger, runId, ["fury"])).rejects.toMatchObject({ code: "validation_failed" });
      await expect(boosts.activate(owner, started, ["aegis"])).rejects.toMatchObject({ code: "boost_run_started" });

      expect(await credits(stranger)).toEqual({ fury: 1 });
      expect(await credits(owner)).toEqual({ fury: 0, aegis: 1 });
    });

    it("итог забега: подарочный буст считается оплаченным", async () => {
      const id = await account();
      await gift(id, "fury", 1);
      const runId = randomUUID();
      await boosts.activate(id, runId, ["fury"]);

      expect(await boosts.checkClaimed(id, runId, ["fury"])).toBe("paid");
      expect(await boosts.ofRun(id, runId)).toEqual(["fury"]);
    });
  });

  describe("возврат несостоявшемуся забегу", () => {
    it("возвращается подарок, а не деньги; повторные возвраты разом — один подарок", async () => {
      const id = await account();
      await fund(id, "coins", 1_000);
      await gift(id, "fury", 1);
      const runId = randomUUID();
      await boosts.activate(id, runId, ["fury"]);
      expect(await credits(id)).toEqual({ fury: 0 });

      const refunds = await Promise.all(Array.from({ length: 5 }, () => boosts.refund(id, runId)));

      expect(refunds.filter((refund) => refund.refunded)).toHaveLength(1);
      expect(await credits(id)).toEqual({ fury: 1 });
      expect(await balance(id, "coins")).toBe(1_000);
      expect(await boostEntries(id)).toBe(0);
      expect((await repository.byRun(runId))?.refundedAt).not.toBeNull();
    }, RACE_TIMEOUT_MS);

    it("набор из подарочного и купленного: подарок назад подарком, купленное — деньгами", async () => {
      const id = await account();
      await fund(id, "coins", 1_000);
      await fund(id, "gems", 10);
      await gift(id, "fury", 1);
      const runId = randomUUID();
      await boosts.activate(id, runId, ["fury", "head_start", "aegis"]);

      expect(await boosts.refund(id, runId)).toEqual({ refunded: true });

      expect(await credits(id)).toEqual({ fury: 1 });
      expect(await balance(id, "coins")).toBe(1_000);
      expect(await balance(id, "gems")).toBe(10);
    });

    it("начатому забегу подарок не возвращается; чужой забег и повтор — тоже", async () => {
      const id = await account();
      await gift(id, "fury", 1);
      const played = randomUUID();
      await boosts.activate(id, played, ["fury"]);
      await start(id, played);

      expect(await boosts.refund(id, played)).toEqual({ refunded: false });
      expect(await boosts.refund(await account(), played)).toEqual({ refunded: false });
      expect(await credits(id)).toEqual({ fury: 0 });
    });

    it("возврат и новая активация разом (подарок и деньги одного игрока): ни взаимной блокировки, ни потери подарка", async () => {
      const id = await account();
      await fund(id, "coins", 2_000);
      await gift(id, "fury", 1);
      const failed = Array.from({ length: 4 }, () => randomUUID());
      for (const runId of failed) await gift(id, "fury", 1).then(() => boosts.activate(id, runId, ["fury", "aegis"]));

      const results = await Promise.allSettled([
        ...failed.map((runId) => boosts.refund(id, runId)),
        ...failed.map(() => boosts.activate(id, randomUUID(), ["fury", "lure"])),
      ]);

      expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    }, RACE_TIMEOUT_MS);

    it("фоновый проход по брошенным покупкам возвращает подарок", async () => {
      const id = await account();
      await gift(id, "fury", 1);
      const old = randomUUID();
      const long = new Date(Date.now() - BOOST_REFUND.windowMs - 60_000);
      await boosts.activate(id, old, ["fury"], long);
      expect(await credits(id)).toEqual({ fury: 0 });

      const locks = new Map<string, string>();
      const redis = {
        set: async (key: string, value: string) => (locks.has(key) ? null : (locks.set(key, value), "OK")),
        eval: async (_script: string, _keys: number, key: string) => (locks.delete(key) ? 1 : 0),
      };
      const refunder = new BoostsRefunder(config, repository, redis as unknown as ConstructorParameters<typeof BoostsRefunder>[2], boosts);

      await refunder.tick();

      expect((await repository.byRun(old))?.refundedAt).not.toBeNull();
      expect(await credits(id)).toEqual({ fury: 1 });
    }, RACE_TIMEOUT_MS);

    it("покупка, записанная до подарков (в журнале нет paid_with): возвращаются деньги, как раньше", async () => {
      const id = await account();
      await fund(id, "coins", 1_000);
      const runId = randomUUID();
      await boosts.activate(id, runId, ["fury"]);
      // Строка прежнего вида: в стоимости только деньги, способа оплаты нет.
      await prisma.$executeRaw`UPDATE run_boost SET cost = '{"coins":150}'::jsonb WHERE run_id = ${runId}`;
      expect(await balance(id, "coins")).toBe(850);

      expect(await boosts.refund(id, runId)).toEqual({ refunded: true });

      expect(await balance(id, "coins")).toBe(1_000);
      expect(await credits(id)).toEqual({});
      expect(await repository.byRun(runId)).toMatchObject({ cost: { coins: 150 }, paidWith: {} });
    });
  });
});
