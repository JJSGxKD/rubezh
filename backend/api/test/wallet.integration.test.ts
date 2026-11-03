import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { BOOST_REASONS, PURCHASE_REASONS, walletCategory } from "../src/modules/history/history-types.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { WALLET_DAILY_CAPS } from "../src/modules/wallet/wallet-limits.js";
import { IdempotencyConflictError, InsufficientFundsError } from "../src/modules/wallet/wallet-errors.js";
import { walletMismatches } from "../src/modules/wallet/wallet-reconcile.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Кошелёк на живом Postgres (docs/17-testing-strategy.md §4.2; адрес —
 * TEST_DATABASE_URL, без него пропуск). Критерий приёмки WP3: сто
 * параллельных одинаковых начислений дают одно, списание больше остатка
 * отклоняется без гонки, баланс сходится с журналом.
 *
 * Память этого не покажет: идемпотентность держит уникальный индекс, потолок
 * суток — блокировка строки, остаток — условие в `UPDATE` и `CHECK` в базе.
 *
 * Пул у теста свой, шире боевого и с долгим ожиданием: проверяется поведение
 * базы под гонкой, а не настройка пула. С боевым пулом в десять соединений
 * сто транзакций на полном прогоне, когда базу делят соседние файлы, ждут
 * очереди дольше его трёх секунд — и тест падал бы на пуле, а не на кошельке.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const ADMIN_TELEGRAM_ID = "777000222";
const RUN_CAP = WALLET_DAILY_CAPS.run_reward.coins ?? 0;
/** 25 сентября 2026, 23:50 по Москве */
const LATE_EVENING = new Date(Date.UTC(2026, 8, 25, 20, 50, 0));
const TWENTY_MINUTES = 20 * 60_000;
/**
 * Гонкам — с запасом: на полном прогоне базу делят соседние файлы, и сотня
 * транзакций идёт секунды, а не миллисекунды.
 */
const RACE_TIMEOUT_MS = 30_000;

describe.skipIf(DATABASE_URL === "")("кошелёк на живом Postgres", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let wallet: WalletService;

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(720_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Кошелёк", username: null },
      Date.now(),
    );
    return created.accountId;
  }

  async function entries(accountId: string): Promise<number> {
    return await prisma.walletEntry.count({ where: { accountId } });
  }

  async function funded(coins: number): Promise<string> {
    const id = await account();
    await wallet.grant({ accountId: id, resource: "coins", amount: coins, reason: "admin_adjust", idempotencyKey: `fund:${randomUUID()}` });
    return id;
  }

  beforeAll(() => {
    config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL, ADMIN_TELEGRAM_IDS: ADMIN_TELEGRAM_ID } as NodeJS.ProcessEnv);
    prisma = testPrisma(DATABASE_URL, 20);
    accounts = new PrismaAccountRepository(prisma);
    const roles = new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository());
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, roles);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("сто параллельных одинаковых начислений дают одно", async () => {
    const id = await account();
    const key = `run:${randomUUID()}:coins`;

    const results = await Promise.all(
      Array.from({ length: 100 }, () => wallet.grant({ accountId: id, resource: "coins", amount: 150, reason: "run_reward", idempotencyKey: key })),
    );

    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(results.every((result) => result.credited === 150 && result.balance === 150)).toBe(true);
    expect((await wallet.balances(id)).coins).toBe(150);
    expect(await entries(id)).toBe(1);
  }, RACE_TIMEOUT_MS);

  it("начисление без потолка тоже идемпотентно под гонкой", async () => {
    const id = await account();
    const key = `purchase:${randomUUID()}`;

    await Promise.all(Array.from({ length: 50 }, () => wallet.grant({ accountId: id, resource: "gems", amount: 100, reason: "purchase", idempotencyKey: key })));

    expect((await wallet.balances(id)).gems).toBe(100);
    expect(await entries(id)).toBe(1);
  }, RACE_TIMEOUT_MS);

  it("суточный потолок не пробивается параллельными начислениями", async () => {
    const id = await account();
    const each = RUN_CAP / 20;

    const results = await Promise.all(
      Array.from({ length: 30 }, () => wallet.grant({ accountId: id, resource: "coins", amount: each, reason: "run_reward", idempotencyKey: `run:${randomUUID()}:coins`, at: LATE_EVENING })),
    );

    expect(results.reduce((sum, result) => sum + result.credited, 0)).toBe(RUN_CAP);
    expect((await wallet.balances(id)).coins).toBe(RUN_CAP);
    // Строки пишутся и с нулём: ключ занят, повтор завтра задним числом не начислит.
    expect(await entries(id)).toBe(30);
  }, RACE_TIMEOUT_MS);

  it("потолок обнуляется в полночь по Москве, а не по UTC", async () => {
    const id = await account();
    await wallet.grant({ accountId: id, resource: "coins", amount: RUN_CAP, reason: "run_reward", idempotencyKey: `run:${randomUUID()}:coins`, at: LATE_EVENING });

    const sameDay = await wallet.grant({ accountId: id, resource: "coins", amount: 10, reason: "run_reward", idempotencyKey: `run:${randomUUID()}:coins`, at: new Date(LATE_EVENING.getTime() + 5 * 60_000) });
    // 00:10 по Москве 26-го — по UTC ещё 25-е, 21:10.
    const nextDay = await wallet.grant({ accountId: id, resource: "coins", amount: 10, reason: "run_reward", idempotencyKey: `run:${randomUUID()}:coins`, at: new Date(LATE_EVENING.getTime() + TWENTY_MINUTES) });

    expect(sameDay.credited).toBe(0);
    expect(nextDay.credited).toBe(10);
  });

  it("повтор с ключом, упёршимся в потолок, не начисляет и на следующие сутки", async () => {
    const id = await account();
    await wallet.grant({ accountId: id, resource: "coins", amount: RUN_CAP, reason: "run_reward", idempotencyKey: `run:${randomUUID()}:coins`, at: LATE_EVENING });
    const key = `run:${randomUUID()}:coins`;
    await wallet.grant({ accountId: id, resource: "coins", amount: 10, reason: "run_reward", idempotencyKey: key, at: LATE_EVENING });

    const retried = await wallet.grant({ accountId: id, resource: "coins", amount: 10, reason: "run_reward", idempotencyKey: key, at: new Date(LATE_EVENING.getTime() + TWENTY_MINUTES) });

    expect(retried).toMatchObject({ duplicate: true, credited: 0, balance: RUN_CAP });
  });

  it("у разных источников — разные потолки", async () => {
    const id = await account();
    await wallet.grant({ accountId: id, resource: "coins", amount: RUN_CAP, reason: "run_reward", idempotencyKey: `run:${randomUUID()}:coins` });

    const task = await wallet.grant({ accountId: id, resource: "coins", amount: 100, reason: "task_reward", idempotencyKey: `task:${randomUUID()}` });

    expect(task.credited).toBe(100);
  });

  it("списание больше остатка отклоняется и ничего не пишет", async () => {
    const id = await funded(100);

    await expect(wallet.spend({ accountId: id, lines: [{ resource: "coins", amount: 101 }], reason: "unlock", idempotencyKey: `unlock:${randomUUID()}` })).rejects.toMatchObject({
      code: "insufficient_funds",
      needed: 101,
      balance: 100,
    });
    expect((await wallet.balances(id)).coins).toBe(100);
    expect(await entries(id)).toBe(1);
  });

  it("параллельные траты не уводят баланс в минус", async () => {
    const id = await funded(100);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => wallet.spend({ accountId: id, lines: [{ resource: "coins", amount: 30 }], reason: "boost", idempotencyKey: `boost:${randomUUID()}` })),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((result) => result.status === "rejected").every((result) => result.reason instanceof InsufficientFundsError)).toBe(true);
    expect((await wallet.balances(id)).coins).toBe(10);
  }, RACE_TIMEOUT_MS);

  it("повтор траты не списывает дважды", async () => {
    const id = await funded(100);
    const key = `unlock:${randomUUID()}`;

    const [first, second] = await Promise.all([
      wallet.spend({ accountId: id, lines: [{ resource: "coins", amount: 40 }], reason: "unlock", idempotencyKey: key }),
      wallet.spend({ accountId: id, lines: [{ resource: "coins", amount: 40 }], reason: "unlock", idempotencyKey: key }),
    ]);

    expect([first.duplicate, second.duplicate].sort()).toEqual([false, true]);
    expect((await wallet.balances(id)).coins).toBe(60);
  });

  it("трата нескольких ресурсов откатывается целиком, если не хватило одного", async () => {
    const id = await funded(500);
    await wallet.grant({ accountId: id, resource: "shard_rare", amount: 3, reason: "salvage", idempotencyKey: `salvage:${randomUUID()}` });

    await expect(
      wallet.spend({
        accountId: id,
        lines: [
          { resource: "coins", amount: 200 },
          { resource: "shard_rare", amount: 5 },
        ],
        reason: "item_upgrade",
        idempotencyKey: `upgrade:${randomUUID()}`,
      }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);

    const balances = await wallet.balances(id);
    expect(balances.coins).toBe(500);
    expect(balances.shard_rare).toBe(3);
    expect(await entries(id)).toBe(2);
  });

  it("ключ чужой операции — конфликт, а не молчаливый повтор", async () => {
    const first = await account();
    const second = await account();
    const key = `run:${randomUUID()}:coins`;
    await wallet.grant({ accountId: first, resource: "coins", amount: 50, reason: "run_reward", idempotencyKey: key });

    await expect(wallet.grant({ accountId: second, resource: "coins", amount: 50, reason: "run_reward", idempotencyKey: key })).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect((await wallet.balances(second)).coins).toBe(0);
  });

  it("ручная операция пишет журнал и аудит, повтор кнопки ничего не меняет", async () => {
    const actor = { accountId: await account(), platform: "telegram" as const, platformUserId: ADMIN_TELEGRAM_ID };
    const target = await account();
    const key = randomUUID().replaceAll("-", "");

    const first = await wallet.adjust(actor, { accountId: target, resource: "gems", delta: 40, note: "компенсация за сбой", idempotencyKey: key });
    const again = await wallet.adjust(actor, { accountId: target, resource: "gems", delta: 40, note: "компенсация за сбой", idempotencyKey: key });
    const taken = await wallet.adjust(actor, { accountId: target, resource: "gems", delta: -15, note: "ошибочное начисление", idempotencyKey: randomUUID().replaceAll("-", "") });

    expect(first).toEqual({ applied: 40, balance: 40, duplicate: false });
    expect(again.duplicate).toBe(true);
    expect(taken).toEqual({ applied: -15, balance: 25, duplicate: false });
    const rows = await prisma.walletEntry.findMany({ where: { accountId: target }, orderBy: { createdAt: "asc" } });
    expect(rows.map((row) => [row.reason, Number(row.amount), row.source])).toEqual([
      ["admin_adjust", 40, `admin:${actor.accountId}`],
      ["admin_adjust", -15, `admin:${actor.accountId}`],
    ]);
  });

  it("баланс сходится с журналом, а запись в обход журнала видна сверкой", async () => {
    const id = await funded(300);
    await wallet.spend({ accountId: id, lines: [{ resource: "coins", amount: 120 }], reason: "shop", idempotencyKey: `shop:${randomUUID()}` });
    expect(await walletMismatches(prisma, id)).toEqual([]);

    await prisma.$executeRaw`UPDATE wallet_balance SET balance = balance + 7 WHERE account_id = ${id}::uuid AND resource = 'coins'`;

    expect(await walletMismatches(prisma, id)).toEqual([{ accountId: id, resource: "coins", balance: 187, ledger: 180 }]);
    // Порча — только для этой проверки: общая сверка базы не должна о ней спотыкаться.
    await prisma.$executeRaw`UPDATE wallet_balance SET balance = balance - 7 WHERE account_id = ${id}::uuid AND resource = 'coins'`;
  });

  it("база сама не даёт балансу уйти в минус", async () => {
    const id = await funded(10);

    await expect(prisma.$executeRaw`UPDATE wallet_balance SET balance = -1 WHERE account_id = ${id}::uuid AND resource = 'coins'`).rejects.toThrow(/wallet_balance_non_negative/);
  });
  describe("отзыв начисленного при возврате звёзд (T-0023)", () => {
    function keys() {
      const purchaseId = randomUUID();
      return { grantKey: `purchase:${purchaseId}:gems`, revokeKey: `refund:${purchaseId}:gems` };
    }

    async function bought(accountId: string, grantKey: string, amount: number, resource: "gems" | "coins" = "gems"): Promise<void> {
      await wallet.grant({ accountId, resource, amount, reason: "purchase", source: "shop:starter", idempotencyKey: grantKey });
    }

    async function spent(accountId: string, amount: number): Promise<void> {
      await wallet.spend({ accountId, lines: [{ resource: "gems", amount }], reason: "unlock", idempotencyKey: `spend:${randomUUID()}` });
    }

    function revoke(accountId: string, grantKey: string, idempotencyKey: string, resource: "gems" | "coins" = "gems") {
      return wallet.revokeUpTo({ accountId, resource, grantKey, idempotencyKey, source: "shop:starter" });
    }

    it("начислено 150, на счёте 200 — забрано 150, баланс 50, в журнале строка −150 `refund_revoke`", async () => {
      const id = await account();
      const { grantKey, revokeKey } = keys();
      await bought(id, grantKey, 150);
      await wallet.grant({ accountId: id, resource: "gems", amount: 50, reason: "admin_adjust", idempotencyKey: `fund:${randomUUID()}` });

      const outcome = await revoke(id, grantKey, revokeKey);

      expect(outcome).toEqual({ status: "revoked", revoked: 150, granted: 150, balance: 50 });
      expect((await wallet.balances(id)).gems).toBe(50);
      const entry = await prisma.walletEntry.findUniqueOrThrow({ where: { idempotencyKey: revokeKey } });
      expect(entry).toMatchObject({ accountId: id, resource: "gems", amount: -150n, reason: "refund_revoke", source: "shop:starter" });
    });

    it("начислено 150, на счёте 40 — забрано 40, баланс 0: потраченное не возвращается", async () => {
      const id = await account();
      const { grantKey, revokeKey } = keys();
      await bought(id, grantKey, 150);
      await spent(id, 110);

      const outcome = await revoke(id, grantKey, revokeKey);

      expect(outcome).toEqual({ status: "revoked", revoked: 40, granted: 150, balance: 0 });
      expect((await wallet.balances(id)).gems).toBe(0);
    });

    it("повтор тем же ключом — duplicate с тем, что забрали тогда; баланс и журнал не меняются", async () => {
      const id = await account();
      const { grantKey, revokeKey } = keys();
      await bought(id, grantKey, 150);
      await spent(id, 110);
      await revoke(id, grantKey, revokeKey);
      // После отзыва игрок заработал ещё самоцветов: повтор их не трогает.
      await wallet.grant({ accountId: id, resource: "gems", amount: 100, reason: "admin_adjust", idempotencyKey: `fund:${randomUUID()}` });
      const before = await entries(id);

      const again = await revoke(id, grantKey, revokeKey);

      expect(again).toEqual({ status: "duplicate", revoked: 40, granted: 150 });
      expect((await wallet.balances(id)).gems).toBe(100);
      expect(await entries(id)).toBe(before);
    });

    it("записи начисления нет — nothing, журнал не тронут", async () => {
      const id = await account();
      const { grantKey, revokeKey } = keys();
      await wallet.grant({ accountId: id, resource: "gems", amount: 30, reason: "admin_adjust", idempotencyKey: `fund:${randomUUID()}` });
      const before = await entries(id);

      const outcome = await revoke(id, grantKey, revokeKey);

      expect(outcome).toEqual({ status: "nothing", granted: 0 });
      expect(await entries(id)).toBe(before);
      expect((await wallet.balances(id)).gems).toBe(30);
    });

    it("баланс 0 — nothing с тем, сколько начислено, строка журнала не создаётся", async () => {
      const id = await account();
      const { grantKey, revokeKey } = keys();
      await bought(id, grantKey, 150);
      await spent(id, 150);
      const before = await entries(id);

      const outcome = await revoke(id, grantKey, revokeKey);

      expect(outcome).toEqual({ status: "nothing", granted: 150 });
      expect(await entries(id)).toBe(before);
      expect(await prisma.walletEntry.findUnique({ where: { idempotencyKey: revokeKey } })).toBeNull();
      expect((await wallet.balances(id)).gems).toBe(0);
    });

    it("нет строки баланса вовсе — тоже nothing, а не ошибка", async () => {
      const id = await account();
      const { grantKey, revokeKey } = keys();

      await expect(revoke(id, grantKey, revokeKey)).resolves.toEqual({ status: "nothing", granted: 0 });
    });

    it("начисление чужого аккаунта и другого ресурса не отзывается тем же ключом", async () => {
      const owner = await account();
      const other = await account();
      const { grantKey, revokeKey } = keys();
      await bought(owner, grantKey, 150);
      await wallet.grant({ accountId: other, resource: "gems", amount: 500, reason: "admin_adjust", idempotencyKey: `fund:${randomUUID()}` });
      await wallet.grant({ accountId: owner, resource: "coins", amount: 80, reason: "admin_adjust", idempotencyKey: `fund:${randomUUID()}` });

      await expect(revoke(other, grantKey, revokeKey)).resolves.toEqual({ status: "nothing", granted: 0 });
      await expect(revoke(owner, grantKey, `${revokeKey}:c`, "coins")).resolves.toEqual({ status: "nothing", granted: 0 });
      expect((await wallet.balances(other)).gems).toBe(500);
      expect((await wallet.balances(owner)).coins).toBe(80);
    });

    it("ключ отзыва, занятый чужой операцией, — ошибка, а не молчаливый duplicate", async () => {
      const first = await account();
      const second = await account();
      const { grantKey, revokeKey } = keys();
      await bought(first, grantKey, 100);
      await revoke(first, grantKey, revokeKey);
      const otherGrant = keys().grantKey;
      await bought(second, otherGrant, 100);

      await expect(revoke(second, otherGrant, revokeKey)).rejects.toThrow();
    });

    it("потолки и суточные счётчики отзыв не трогает", async () => {
      const id = await account();
      const { grantKey, revokeKey } = keys();
      await bought(id, grantKey, 150);

      await revoke(id, grantKey, revokeKey);

      expect(await prisma.walletDaily.count({ where: { accountId: id } })).toBe(0);
    });

    it("двадцать параллельных вызовов одним ключом — одна строка журнала, баланс уменьшен один раз", async () => {
      const id = await account();
      const { grantKey, revokeKey } = keys();
      await bought(id, grantKey, 150);
      await wallet.grant({ accountId: id, resource: "gems", amount: 50, reason: "admin_adjust", idempotencyKey: `fund:${randomUUID()}` });

      const results = await Promise.all(Array.from({ length: 20 }, () => revoke(id, grantKey, revokeKey)));

      expect(results.filter((result) => result.status === "revoked")).toHaveLength(1);
      expect(results.filter((result) => result.status === "duplicate")).toHaveLength(19);
      expect(results.every((result) => result.status !== "nothing" && result.revoked === 150)).toBe(true);
      expect((await wallet.balances(id)).gems).toBe(50);
      expect(await prisma.walletEntry.count({ where: { idempotencyKey: revokeKey } })).toBe(1);
    }, RACE_TIMEOUT_MS);

    it("два параллельных отзыва разными ключами при балансе 100 и начислениях по 80 — забрано не больше 100, баланс не ниже нуля", async () => {
      const id = await account();
      const first = keys();
      const second = keys();
      await bought(id, first.grantKey, 80);
      await bought(id, second.grantKey, 80);
      await spent(id, 60);

      const results = await Promise.all([revoke(id, first.grantKey, first.revokeKey), revoke(id, second.grantKey, second.revokeKey)]);

      const taken = results.reduce((sum, result) => sum + (result.status === "revoked" ? result.revoked : 0), 0);
      expect(taken).toBe(100);
      expect((await wallet.balances(id)).gems).toBe(0);
    }, RACE_TIMEOUT_MS);

    it("отзыв и трата идут в очередь на одной строке баланса: баланс не уходит в минус", async () => {
      const id = await account();
      const { grantKey, revokeKey } = keys();
      await bought(id, grantKey, 100);

      const results = await Promise.allSettled([
        revoke(id, grantKey, revokeKey),
        ...Array.from({ length: 5 }, () => wallet.spend({ accountId: id, lines: [{ resource: "gems", amount: 30 }], reason: "unlock", idempotencyKey: `spend:${randomUUID()}` })),
      ]);

      expect(results[0]?.status).toBe("fulfilled");
      const balance = (await wallet.balances(id)).gems;
      expect(balance).toBeGreaterThanOrEqual(0);
      // Журнал сходится с балансом, что бы ни победило в гонке.
      expect(await walletMismatches(prisma, id)).toEqual([]);
    }, RACE_TIMEOUT_MS);

    it("ключи проверяются: пустой или длиннее предела — отказ до базы", async () => {
      const id = await account();

      await expect(revoke(id, "", "refund:x")).rejects.toThrow();
      await expect(revoke(id, "purchase:x", "k".repeat(200))).rejects.toThrow();
    });
  });

  describe("отзыв награды за задание при отписке (T-0177)", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** Награда за задание — как её пишет `TasksService`: ключ `task:<аккаунт>:<задание>:<период>:<ресурс>`. */
    function keys(accountId: string) {
      const taskId = `t${randomUUID().slice(0, 8)}`;
      return { grantKey: `task:${accountId}:${taskId}:2026-10-20:coins`, revokeKey: `task-revoke:${accountId}:${taskId}:2026-10-20:coins` };
    }

    async function rewarded(accountId: string, grantKey: string, amount = 100): Promise<void> {
      await wallet.grant({ accountId, resource: "coins", amount, reason: "task_reward", source: "tasks:t1", idempotencyKey: grantKey });
    }

    async function spentCoins(accountId: string, amount: number): Promise<void> {
      await wallet.spend({ accountId, lines: [{ resource: "coins", amount }], reason: "unlock", idempotencyKey: `spend:${randomUUID()}` });
    }

    async function fund(accountId: string, amount: number): Promise<void> {
      await wallet.grant({ accountId, resource: "coins", amount, reason: "admin_adjust", idempotencyKey: `fund:${randomUUID()}` });
    }

    function revokeTask(accountId: string, grantKey: string, idempotencyKey: string) {
      return wallet.revokeUpTo({ accountId, resource: "coins", grantKey, idempotencyKey, source: "tasks:unsubscribe", reason: "task_revoke" });
    }

    it("награда 100, на счёте 60 — забрано 60, баланс 0, в журнале −60 с причиной `task_revoke`, источник и ключ как переданы", async () => {
      const id = await account();
      const { grantKey, revokeKey } = keys(id);
      await rewarded(id, grantKey);
      await spentCoins(id, 40);

      const outcome = await revokeTask(id, grantKey, revokeKey);

      expect(outcome).toEqual({ status: "revoked", revoked: 60, granted: 100, balance: 0 });
      expect((await wallet.balances(id)).coins).toBe(0);
      const entry = await prisma.walletEntry.findUniqueOrThrow({ where: { idempotencyKey: revokeKey } });
      expect(entry).toMatchObject({ accountId: id, resource: "coins", amount: -60n, reason: "task_revoke", source: "tasks:unsubscribe", idempotencyKey: revokeKey });
      expect(await walletMismatches(prisma, id)).toEqual([]);
    });

    it("на счёте 250 — забрано 100, баланс 150: не больше начисленного", async () => {
      const id = await account();
      const { grantKey, revokeKey } = keys(id);
      await rewarded(id, grantKey);
      await fund(id, 150);

      const outcome = await revokeTask(id, grantKey, revokeKey);

      expect(outcome).toEqual({ status: "revoked", revoked: 100, granted: 100, balance: 150 });
      expect((await wallet.balances(id)).coins).toBe(150);
    });

    it("баланс 0 — nothing, строка не создаётся; когда на счёте появилось 30, повтор того же отзыва забирает 30", async () => {
      const id = await account();
      const { grantKey, revokeKey } = keys(id);
      await rewarded(id, grantKey);
      await spentCoins(id, 100);
      const before = await entries(id);

      await expect(revokeTask(id, grantKey, revokeKey)).resolves.toEqual({ status: "nothing", granted: 100 });
      expect(await entries(id)).toBe(before);
      expect(await prisma.walletEntry.findUnique({ where: { idempotencyKey: revokeKey } })).toBeNull();

      await fund(id, 30);
      await expect(revokeTask(id, grantKey, revokeKey)).resolves.toEqual({ status: "revoked", revoked: 30, granted: 100, balance: 0 });
      expect((await wallet.balances(id)).coins).toBe(0);
    });

    it("повтор того же ключа с той же причиной — duplicate: второй строки нет, баланс не менялся", async () => {
      const id = await account();
      const { grantKey, revokeKey } = keys(id);
      await rewarded(id, grantKey);
      await spentCoins(id, 40);
      await revokeTask(id, grantKey, revokeKey);
      // После отзыва игрок заработал ещё: повтор этих монет не трогает.
      await fund(id, 70);
      const before = await entries(id);

      const again = await revokeTask(id, grantKey, revokeKey);

      expect(again).toEqual({ status: "duplicate", revoked: 60, granted: 100 });
      expect((await wallet.balances(id)).coins).toBe(70);
      expect(await entries(id)).toBe(before);
      expect(await prisma.walletEntry.count({ where: { idempotencyKey: revokeKey } })).toBe(1);
    });

    it("два и двадцать одновременных одинаковых отзыва — одна строка журнала, баланс уменьшен один раз", async () => {
      const id = await account();
      const { grantKey, revokeKey } = keys(id);
      await rewarded(id, grantKey);
      await fund(id, 50);

      const pair = await Promise.all([revokeTask(id, grantKey, revokeKey), revokeTask(id, grantKey, revokeKey)]);
      expect(pair.map((result) => result.status).sort()).toEqual(["duplicate", "revoked"]);

      const other = keys(id);
      await rewarded(id, other.grantKey);
      const many = await Promise.all(Array.from({ length: 20 }, () => revokeTask(id, other.grantKey, other.revokeKey)));
      expect(many.filter((result) => result.status === "revoked")).toHaveLength(1);
      expect(many.filter((result) => result.status === "duplicate")).toHaveLength(19);
      expect(await prisma.walletEntry.count({ where: { idempotencyKey: revokeKey } })).toBe(1);
      expect(await prisma.walletEntry.count({ where: { idempotencyKey: other.revokeKey } })).toBe(1);
      // Забрано ровно две награды по 100, остаток — 50 из пополнения.
      expect((await wallet.balances(id)).coins).toBe(50);
      expect(await walletMismatches(prisma, id)).toEqual([]);
    }, RACE_TIMEOUT_MS);

    it("ключ отзыва занят записью с другой причиной — повтор бросает `IdempotencyConflictError`, в обе стороны", async () => {
      const id = await account();
      const { grantKey, revokeKey } = keys(id);
      await rewarded(id, grantKey);
      await fund(id, 30);
      // Возврат звёзд: причина по умолчанию.
      await wallet.revokeUpTo({ accountId: id, resource: "coins", grantKey, idempotencyKey: revokeKey, source: "shop:starter" });
      const before = await entries(id);

      await expect(revokeTask(id, grantKey, revokeKey)).rejects.toBeInstanceOf(IdempotencyConflictError);
      expect(await entries(id)).toBe(before);

      const second = keys(id);
      await rewarded(id, second.grantKey);
      await revokeTask(id, second.grantKey, second.revokeKey);
      await expect(wallet.revokeUpTo({ accountId: id, resource: "coins", grantKey: second.grantKey, idempotencyKey: second.revokeKey, source: "shop:starter" })).rejects.toBeInstanceOf(
        IdempotencyConflictError,
      );
    });

    it("чужой ключ награды (другого аккаунта) ничего не отзывает: granted 0, баланс и журнал целы", async () => {
      const owner = await account();
      const other = await account();
      const { grantKey, revokeKey } = keys(owner);
      await rewarded(owner, grantKey);
      await fund(other, 500);
      const before = await entries(other);

      await expect(revokeTask(other, grantKey, revokeKey)).resolves.toEqual({ status: "nothing", granted: 0 });

      expect((await wallet.balances(other)).coins).toBe(500);
      expect((await wallet.balances(owner)).coins).toBe(100);
      expect(await entries(other)).toBe(before);
    });

    it("без `reason` запись по-прежнему `refund_revoke`; явная причина возврата — то же", async () => {
      const id = await account();
      const first = keys(id);
      const second = keys(id);
      await rewarded(id, first.grantKey);
      await rewarded(id, second.grantKey);

      await wallet.revokeUpTo({ accountId: id, resource: "coins", grantKey: first.grantKey, idempotencyKey: first.revokeKey, source: "shop:starter" });
      await wallet.revokeUpTo({ accountId: id, resource: "coins", grantKey: second.grantKey, idempotencyKey: second.revokeKey, source: "shop:starter", reason: "refund_revoke" });

      const rows = await prisma.walletEntry.findMany({ where: { idempotencyKey: { in: [first.revokeKey, second.revokeKey] } }, orderBy: { idempotencyKey: "asc" } });
      expect(rows.map((row) => row.reason)).toEqual(["refund_revoke", "refund_revoke"]);
    });

    it("отзыв награды и возврат звёзд одновременно на одной строке баланса: забрано не больше остатка, журнал сходится", async () => {
      const id = await account();
      const task = keys(id);
      const purchaseId = randomUUID();
      await rewarded(id, task.grantKey, 80);
      await wallet.grant({ accountId: id, resource: "coins", amount: 80, reason: "admin_adjust", source: "shop:starter", idempotencyKey: `purchase:${purchaseId}:coins` });
      await spentCoins(id, 60);

      const results = await Promise.all([
        revokeTask(id, task.grantKey, task.revokeKey),
        wallet.revokeUpTo({ accountId: id, resource: "coins", grantKey: `purchase:${purchaseId}:coins`, idempotencyKey: `refund:${purchaseId}:coins`, source: "shop:starter" }),
      ]);

      const taken = results.reduce((sum, result) => sum + (result.status === "revoked" ? result.revoked : 0), 0);
      expect(taken).toBe(100);
      expect((await wallet.balances(id)).coins).toBe(0);
      expect(await walletMismatches(prisma, id)).toEqual([]);
    }, RACE_TIMEOUT_MS);

    it("потолки и суточные счётчики отзыв награды не трогает", async () => {
      const id = await account();
      const { grantKey, revokeKey } = keys(id);
      await rewarded(id, grantKey);
      const before = await prisma.walletDaily.findMany({ where: { accountId: id } });

      await revokeTask(id, grantKey, revokeKey);

      expect(await prisma.walletDaily.findMany({ where: { accountId: id } })).toEqual(before);
    });

    it("лог `wallet_revoked` несёт причину: `task_revoke` у награды за задание, `refund_revoke` у возврата звёзд", async () => {
      const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      const id = await account();
      const task = keys(id);
      const refund = keys(id);
      await rewarded(id, task.grantKey);
      await rewarded(id, refund.grantKey);

      await revokeTask(id, task.grantKey, task.revokeKey);
      await wallet.revokeUpTo({ accountId: id, resource: "coins", grantKey: refund.grantKey, idempotencyKey: refund.revokeKey, source: "shop:starter" });
      // Повтор лог не растит.
      await revokeTask(id, task.grantKey, task.revokeKey);

      // Соседние файлы пишут в тот же Logger: не-JSON строки читаются как пустые.
      const parse = (message: unknown): { event?: string; accountId?: string; reason?: string } => {
        try {
          return JSON.parse(String(message)) as { event?: string; accountId?: string; reason?: string };
        } catch {
          return {};
        }
      };
      const logged = warn.mock.calls.map(([message]) => parse(message)).filter((line) => line.event === "wallet_revoked" && line.accountId === id);
      expect(logged.map((line) => line.reason)).toEqual(["task_revoke", "refund_revoke"]);
    });

    it("ключи проверяются и с причиной: пустой или длиннее предела — отказ до базы", async () => {
      const id = await account();

      await expect(revokeTask(id, "", "task-revoke:x")).rejects.toThrow();
      await expect(revokeTask(id, "task:x", "k".repeat(200))).rejects.toThrow();
    });
  });
});

/**
 * Причина отзыва награды в истории игрока (T-0177): это списание за отписку, а
 * не покупка и не буст, поэтому строка остаётся среди валюты и осколков. Тест
 * чистый, без базы — стоит вне блока живого Postgres, чтобы идти всегда.
 */
describe("причина отзыва награды за задание в истории", () => {
  it("не попадает ни в покупки, ни в бусты: монеты и самоцветы — валюта, осколки — осколки", () => {
    expect(PURCHASE_REASONS.has("task_revoke")).toBe(false);
    expect(BOOST_REASONS.has("task_revoke")).toBe(false);
    expect(walletCategory("coins", "task_revoke")).toBe("currency");
    expect(walletCategory("gems", "task_revoke")).toBe("currency");
    expect(walletCategory("shard_common", "task_revoke")).toBe("shards");
    // Возврат звёзд по-прежнему в покупках.
    expect(walletCategory("gems", "refund_revoke")).toBe("purchases");
  });
});
