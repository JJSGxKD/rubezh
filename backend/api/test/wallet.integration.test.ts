import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { WALLET_DAILY_CAPS } from "../src/modules/wallet/wallet-limits.js";
import { IdempotencyConflictError, InsufficientFundsError } from "../src/modules/wallet/wallet-errors.js";
import { walletMismatches } from "../src/modules/wallet/wallet-reconcile.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

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
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 20, connectionTimeoutMillis: 30_000 }) });
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
});
