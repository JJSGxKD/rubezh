import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { BOOST_REFUND } from "../src/modules/boosts/boosts-limits.js";
import { BoostsRefunder } from "../src/modules/boosts/boosts-refunder.js";
import { PrismaBoostsRepository } from "../src/modules/boosts/boosts.repository.js";
import { BoostsService } from "../src/modules/boosts/boosts.service.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { PrismaRunsRepository } from "../src/modules/runs/runs.repository.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import type { WalletResource } from "../src/modules/wallet/wallet-types.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { PrismaNotificationsRepository } from "../src/modules/notifications/notifications.repository.js";
import { NotificationsService } from "../src/modules/notifications/notifications.service.js";

/**
 * Бусты на живом Postgres с настоящим кошельком (docs/17-testing-strategy.md
 * §4.2; адрес — TEST_DATABASE_URL, без него пропуск). Критерии приёмки WP8:
 * двойное использование одного буста невозможно, при сбое старта бусты
 * возвращаются, начатому забегу — нет.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const RACE_TIMEOUT_MS = 30_000;

describe.skipIf(DATABASE_URL === "")("бусты на живом Postgres", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let wallet: WalletService;
  let repository: PrismaBoostsRepository;
  let runs: PrismaRunsRepository;
  let boosts: BoostsService;

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(750_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Буст", username: null },
      Date.now(),
    );
    return created.accountId;
  }

  async function fund(accountId: string, resource: WalletResource, amount: number): Promise<void> {
    await wallet.grant({ accountId, resource, amount, reason: resource === "coins" ? "run_reward" : "level_reward", idempotencyKey: `test:${randomUUID()}` });
  }

  const balance = async (accountId: string, resource: WalletResource) => (await wallet.balances(accountId))[resource];
  const start = (accountId: string, runId: string) =>
    runs.start({ runId, accountId, difficulty: "normal", startingWeaponId: "spark", contentHash: "abc", startedAt: new Date() });

  beforeAll(() => {
    config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv);
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 20, connectionTimeoutMillis: 30_000 }) });
    accounts = new PrismaAccountRepository(prisma);
    const roles = new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository());
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, roles);
    repository = new PrismaBoostsRepository(prisma);
    runs = new PrismaRunsRepository(prisma);
    boosts = new BoostsService(repository, wallet, new NotificationsService(new PrismaNotificationsRepository(prisma)));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("покупка списывает монеты и самоцветы, а повтор того же забега — даже под гонкой — ничего", async () => {
    const id = await account();
    await fund(id, "coins", 1_000);
    await fund(id, "gems", 10);
    const runId = randomUUID();

    const results = await Promise.all(Array.from({ length: 10 }, () => boosts.activate(id, runId, ["fury", "head_start"])));

    expect(results.every((result) => result.boosts.join() === "fury,head_start")).toBe(true);
    expect(await balance(id, "coins")).toBe(850);
    expect(await balance(id, "gems")).toBe(6);
    // Повтор с другим набором — прежний набор: покупка на забег одна.
    expect((await boosts.activate(id, runId, ["lure"])).boosts).toEqual(["fury", "head_start"]);
    expect(await balance(id, "coins")).toBe(850);
  }, RACE_TIMEOUT_MS);

  it("не хватило — не списано и не куплено ничего", async () => {
    const id = await account();
    await fund(id, "coins", 1_000);
    const runId = randomUUID();

    await expect(boosts.activate(id, runId, ["fury", "insight"])).rejects.toMatchObject({ code: "insufficient_funds", resource: "gems", balance: 0 });
    expect(await balance(id, "coins")).toBe(1_000);
    expect(await repository.byRun(runId)).toBeNull();
  });

  it("чужой забег и начатый забег бусты не покупают", async () => {
    const owner = await account();
    const stranger = await account();
    await fund(owner, "coins", 1_000);
    await fund(stranger, "coins", 1_000);
    const runId = randomUUID();
    await boosts.activate(owner, runId, ["fury"]);

    await expect(boosts.activate(stranger, runId, ["fury"])).rejects.toMatchObject({ code: "validation_failed" });
    const started = randomUUID();
    await start(owner, started);
    await expect(boosts.activate(owner, started, ["fury"])).rejects.toMatchObject({ code: "boost_run_started" });
    expect(await balance(stranger, "coins")).toBe(1_000);
    expect(await balance(owner, "coins")).toBe(850);
  });

  it("несостоявшийся забег получает бусты назад один раз, начатый — нет", async () => {
    const id = await account();
    await fund(id, "coins", 1_000);
    await fund(id, "gems", 10);
    const failed = randomUUID();
    const played = randomUUID();
    await boosts.activate(id, failed, ["aegis", "insight"]);
    await boosts.activate(id, played, ["fury"]);
    await start(id, played);

    const refunds = await Promise.all(Array.from({ length: 5 }, () => boosts.refund(id, failed)));

    expect(refunds.filter((refund) => refund.refunded)).toHaveLength(1);
    expect(await balance(id, "coins")).toBe(1_000 - 150);
    expect(await balance(id, "gems")).toBe(10);
    expect(await boosts.refund(id, played)).toEqual({ refunded: false });
    expect(await boosts.refund(randomUUID(), failed)).toEqual({ refunded: false });

    // Возврат — в ленту игрока, один раз при пяти запросах (Р51).
    await vi.waitFor(async () => {
      const rows = await prisma.notification.findMany({ where: { accountId: id }, select: { kind: true, payload: true } });
      expect(rows).toEqual([{ kind: "boosts_refunded", payload: { runId: failed, boosts: ["aegis", "insight"], coins: 120, gems: 6 } }]);
    });
  }, RACE_TIMEOUT_MS);

  it("итог: оплаченные бусты — оплачены; не купленные, чужие и возвращённые — нет", async () => {
    const id = await account();
    const other = await account();
    await fund(id, "coins", 1_000);
    const runId = randomUUID();
    await boosts.activate(id, runId, ["fury", "aegis"]);

    expect(await boosts.checkClaimed(id, runId, ["aegis"])).toBe("paid");
    expect(await boosts.checkClaimed(id, runId, ["aegis", "lure"])).toBe("unpaid");
    expect(await boosts.checkClaimed(other, runId, ["aegis"])).toBe("unpaid");
    expect(await boosts.checkClaimed(id, randomUUID(), ["fury"])).toBe("unpaid");

    await boosts.refund(id, runId);
    expect(await boosts.checkClaimed(id, runId, ["fury"])).toBe("unpaid");
  });

  it("фоновый проход возвращает брошенные покупки старше окна — и только их", async () => {
    const id = await account();
    await fund(id, "coins", 1_000);
    const old = randomUUID();
    const fresh = randomUUID();
    const played = randomUUID();
    const long = new Date(Date.now() - BOOST_REFUND.windowMs - 60_000);
    await boosts.activate(id, old, ["lure"], long);
    await boosts.activate(id, played, ["lure"], long);
    await start(id, played);
    await boosts.activate(id, fresh, ["lure"]);

    const locks = new Map<string, string>();
    const redis = {
      set: async (key: string, value: string) => (locks.has(key) ? null : (locks.set(key, value), "OK")),
      eval: async (_script: string, _keys: number, key: string) => (locks.delete(key) ? 1 : 0),
    };
    const refunder = new BoostsRefunder(config, repository, redis as unknown as ConstructorParameters<typeof BoostsRefunder>[2], boosts);

    // Чужие брошенные покупки на общей базе тоже вернутся — считаем только свои.
    await refunder.tick();
    expect((await repository.byRun(old))?.refundedAt).not.toBeNull();
    expect((await repository.byRun(fresh))?.refundedAt).toBeNull();
    expect((await repository.byRun(played))?.refundedAt).toBeNull();
    expect(await balance(id, "coins")).toBe(1_000 - 200);
    // Проход по брошенным тоже пишет в ленту: иначе игрок не узнал бы, откуда монеты.
    await vi.waitFor(async () => {
      expect(await prisma.notification.count({ where: { accountId: id, kind: "boosts_refunded" } })).toBe(1);
    });
  }, RACE_TIMEOUT_MS);
});
