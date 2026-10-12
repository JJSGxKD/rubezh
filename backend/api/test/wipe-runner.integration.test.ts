import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { Prisma, PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { WIPE_ORDER, WIPE_PLAN } from "../src/modules/wipe/wipe-plan.js";
import {
  WipeUsageError,
  deleteAll,
  formatPlan,
  formatResult,
  parseWipeArgs,
  planWipe,
  runWipe,
  type WipeCounts,
} from "../src/modules/wipe/wipe-runner.js";

/**
 * Команда вайпа (tasks/T-0041, docs/35-stage4-plan.md Р87): подсчёт, снимок
 * компенсаций и стирание одной транзакцией.
 *
 * **Общую базу тестов вайп не трогает.** Интеграционная часть создаёт свою
 * временную базу `rubezh_wipe_<случайное>`, прогоняет на ней все миграции и в
 * конце удаляет. Нужен живой Postgres (`TEST_DATABASE_URL`) с правом
 * `CREATE DATABASE`; без права кейсы пропускаются. Разбор аргументов, вывод и
 * ветки стирания проверяются без базы.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const API_DIR = resolve(import.meta.dirname, "..");
const NOW = new Date(Date.UTC(2026, 9, 12, 12, 0, 0));
const TODAY = "2026-10-12";

const lowerFirst = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1);

describe("разбор аргументов команды", () => {
  it("пусто — подсчёт", () => {
    expect(parseWipeArgs([], TODAY)).toEqual({ kind: "plan" });
  });

  it("--plan — подсчёт", () => {
    expect(parseWipeArgs(["--plan"], TODAY)).toEqual({ kind: "plan" });
  });

  it("--run --confirm <сегодня UTC> — запуск", () => {
    expect(parseWipeArgs(["--run", "--confirm", TODAY], TODAY)).toEqual({ kind: "run" });
  });

  it("порядок --confirm и --run не важен", () => {
    expect(parseWipeArgs(["--confirm", TODAY, "--run"], TODAY)).toEqual({ kind: "run" });
  });

  it("вчерашняя и завтрашняя дата — ошибка с подсказкой, код 2", () => {
    for (const date of ["2026-10-11", "2026-10-13"]) {
      const attempt = () => parseWipeArgs(["--run", "--confirm", date], TODAY);
      expect(attempt).toThrow(WipeUsageError);
      expect(attempt).toThrow("Подтвердите сегодняшней датой UTC: --confirm ГГГГ-ММ-ДД");
    }
  });

  it("дата не в виде ГГГГ-ММ-ДД — ошибка", () => {
    for (const date of ["12.10.2026", "2026-10-12T00:00:00Z", "сегодня", ""]) {
      expect(() => parseWipeArgs(["--run", "--confirm", date], TODAY)).toThrow(WipeUsageError);
    }
  });

  it("--run без --confirm — ошибка", () => {
    expect(() => parseWipeArgs(["--run"], TODAY)).toThrow(WipeUsageError);
  });

  it("--confirm без значения — ошибка", () => {
    expect(() => parseWipeArgs(["--run", "--confirm"], TODAY)).toThrow(WipeUsageError);
  });

  it("--confirm без --run не запускает ничего — ошибка", () => {
    expect(() => parseWipeArgs(["--confirm", TODAY], TODAY)).toThrow(WipeUsageError);
  });

  it("--plan вместе с --run — ошибка: запуск не может прятаться за подсчётом", () => {
    expect(() => parseWipeArgs(["--plan", "--run", "--confirm", TODAY], TODAY)).toThrow(WipeUsageError);
  });

  it("лишний аргумент — ошибка", () => {
    expect(() => parseWipeArgs(["--run", "--confirm", TODAY, "--force"], TODAY)).toThrow(WipeUsageError);
    expect(() => parseWipeArgs(["--plan", "лишнее"], TODAY)).toThrow(WipeUsageError);
    expect(() => parseWipeArgs(["--drop"], TODAY)).toThrow(WipeUsageError);
  });

  it("повтор флага — ошибка", () => {
    expect(() => parseWipeArgs(["--run", "--run", "--confirm", TODAY], TODAY)).toThrow(WipeUsageError);
  });
});

describe("стирание модели", () => {
  /** Подмена транзакции: любой делегат отвечает на `deleteMany` и запоминает вызов. */
  function fakeTx() {
    const calls: { delegate: string; args: unknown }[] = [];
    const tx: unknown = new Proxy(
      {},
      {
        get: (_target, delegate) => ({
          deleteMany: async (args: unknown) => {
            calls.push({ delegate: String(delegate), args });
            return { count: 7 };
          },
        }),
      },
    );
    return { tx: tx as Prisma.TransactionClient, calls };
  }

  it("у каждой стираемой модели плана есть ветка: один deleteMany({}) своего делегата", async () => {
    for (const model of WIPE_ORDER) {
      const { tx, calls } = fakeTx();

      const result = await deleteAll(tx, model);

      expect(result, model).toEqual({ count: 7 });
      expect(calls, model).toEqual([{ delegate: lowerFirst(model), args: {} }]);
    }
  });

  it("модель, которую план оставляет, deleteAll не стирает — отказ без обращения к базе", async () => {
    const kept = Object.entries(WIPE_PLAN)
      .filter(([, decision]) => decision.action === "keep")
      .map(([model]) => model as Prisma.ModelName);
    expect(kept.length).toBeGreaterThan(0);
    for (const model of kept) {
      const { tx, calls } = fakeTx();

      await expect(deleteAll(tx, model), model).rejects.toThrow("не входит в план стирания");

      expect(calls, model).toEqual([]);
    }
  });
});

describe("вывод команды", () => {
  function counts(patch: Partial<Record<Prisma.ModelName, number>> = {}): WipeCounts {
    const rows = Object.fromEntries(Object.keys(WIPE_PLAN).map((model) => [model, 0])) as Record<Prisma.ModelName, number>;
    return {
      rows: { ...rows, Run: 12_345, Purchase: 321, Account: 1_000_000, ...patch },
      snapshot: { accounts: 3, testers: 2, bonusGems: 310, restored: { gems: 150, coins: 400 }, continueStars: 14 },
    };
  }

  it("сначала стираемые модели в порядке плана, затем оставляемые по алфавиту", () => {
    const lines = formatPlan(counts(), TODAY);

    const wiped = lines.filter((line) => line.startsWith("стереть"));
    const kept = lines.filter((line) => line.startsWith("оставить"));
    expect(wiped.map((line) => line.split(/\s{2,}/)[1])).toEqual([...WIPE_ORDER]);
    expect(kept.map((line) => line.split(/\s{2,}/)[1])).toEqual(
      Object.entries(WIPE_PLAN)
        .filter(([, decision]) => decision.action === "keep")
        .map(([model]) => model)
        .sort(),
    );
    expect(lines.indexOf(wiped[wiped.length - 1] ?? "")).toBeLessThan(lines.indexOf(kept[0] ?? ""));
  });

  it("строка модели: действие, имя, число с пробелами между разрядами", () => {
    const lines = formatPlan(counts(), TODAY);

    expect(lines).toContain("стереть  Run  12 345");
    expect(lines).toContain("оставить  Purchase  321");
    expect(lines).toContain("оставить  Account  1 000 000");
  });

  it("итоги снимка: тестеры, строки, бонус, звёзды второго шанса, возврат по ресурсам", () => {
    const text = formatPlan(counts(), TODAY).join("\n");

    expect(text).toContain("тестеров: 2");
    expect(text).toContain("строк компенсации: 3");
    expect(text).toContain("бонус тестерам, самоцветов: 310");
    expect(text).toContain("звёзд за второй шанс к переводу в самоцветы: 14");
    expect(text).toContain("gems 150");
    expect(text).toContain("coins 400");
  });

  it("возвращать нечего — так и написано", () => {
    const empty = counts();
    empty.snapshot = { accounts: 0, testers: 0, bonusGems: 0, restored: {}, continueStars: 0 };

    expect(formatPlan(empty, TODAY).join("\n")).toContain("вернётся из купленного: ничего");
  });

  it("последняя строка подсчёта — что ничего не изменено и как запускать", () => {
    const lines = formatPlan(counts(), TODAY);

    expect(lines.at(-1)).toBe(`Ничего не изменено. Запуск: wipe --run --confirm ${TODAY}`);
  });

  it("итог запуска: удалённые строки по моделям в порядке плана и итоги снимка", () => {
    const deleted = Object.fromEntries(WIPE_ORDER.map((model, index) => [model, index])) as Partial<Record<Prisma.ModelName, number>>;

    const lines = formatResult({ deleted, snapshot: counts().snapshot });

    expect(lines.filter((line) => line.startsWith("стёрто")).map((line) => line.split(/\s{2,}/)[1])).toEqual([...WIPE_ORDER]);
    expect(lines.join("\n")).toContain("тестеров: 2");
  });
});

describe.skipIf(DATABASE_URL === "")("команда вайпа на временной базе", () => {
  const databaseName = `rubezh_wipe_${randomBytes(6).toString("hex")}`;
  let admin: PrismaClient;
  let prisma: PrismaClient;
  let skipReason = "";

  const withDatabase = (name: string): string => {
    const url = new URL(DATABASE_URL);
    url.pathname = `/${name}`;
    return url.toString();
  };

  beforeAll(async () => {
    admin = createPrisma(loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv));
    try {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    } catch (error: unknown) {
      skipReason = `нельзя создать временную базу: ${error instanceof Error ? error.message : "unknown"}`;
      return;
    }
    execFileSync(resolve(API_DIR, "node_modules/.bin/prisma"), ["migrate", "deploy"], {
      cwd: API_DIR,
      env: { ...process.env, DATABASE_URL: withDatabase(databaseName) },
      stdio: "pipe",
      timeout: 240_000,
    });
    prisma = createPrisma(loadAppConfig({ NODE_ENV: "test", DATABASE_URL: withDatabase(databaseName) } as NodeJS.ProcessEnv));
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (skipReason === "") await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.$disconnect();
  }, 60_000);

  const ids = {
    tester: randomUUID(),
    friend: randomUUID(),
    run: randomUUID(),
    shopPurchase: randomUUID(),
    continuePurchase: randomUUID(),
    vipPurchase: randomUUID(),
  };

  async function account(accountId: string, name: string): Promise<void> {
    await prisma.account.create({ data: { accountId, platform: "telegram", platformUserId: `w${accountId.replaceAll("-", "").slice(0, 20)}`, displayName: name } });
  }

  /** Тестер 12-го уровня со всем, что вайп стирает, и со всем, что остаётся; рядом его друг. */
  async function seed(): Promise<void> {
    await account(ids.tester, "Тестер");
    await account(ids.friend, "Друг");
    await prisma.accountProgress.create({ data: { accountId: ids.tester, level: 12, updatedAt: NOW } });
    await prisma.run.create({
      data: { runId: ids.run, accountId: ids.tester, status: "finished", difficulty: "normal", startingWeaponId: "knife", contentHash: "abc", cheats: false, finishedAt: NOW },
    });
    await prisma.item.create({
      data: { itemId: randomUUID(), accountId: ids.tester, slot: "weapon", rarity: "rare", level: 3, seed: 7n, rolls: [], source: "run", createdAt: NOW, updatedAt: NOW },
    });
    await prisma.walletBalance.create({ data: { accountId: ids.tester, resource: "gems", balance: 200n, updatedAt: NOW } });
    await prisma.walletDaily.create({ data: { accountId: ids.tester, resource: "gems", reason: "run_reward", day: NOW, granted: 5n } });
    await prisma.dailyReward.create({ data: { accountId: ids.tester, claimedDays: 2, lastClaimDay: NOW, updatedAt: NOW } });
    await prisma.notification.create({ data: { notificationId: randomUUID(), accountId: ids.tester, kind: "test", payload: {}, dedupeKey: "k1", createdAt: NOW } });

    // Купленный набор: покупка и выдача в журнале тем же ключом, что пишет магазин.
    await prisma.purchase.create({
      data: {
        purchaseId: ids.shopPurchase, accountId: ids.tester, product: "shop_item", sku: "starter", priceStars: 50, chargedStars: 50, mode: "live", status: "paid",
        telegramChargeId: randomUUID(), invoicedAt: NOW, paidAt: NOW, fulfilledAt: NOW,
      },
    });
    await prisma.walletEntry.create({
      data: { entryId: randomUUID(), accountId: ids.tester, resource: "gems", amount: 150n, reason: "purchase", source: "shop:starter", idempotencyKey: `purchase:${ids.shopPurchase}:gems`, createdAt: NOW },
    });
    // Второй шанс его забега: после вайпа забега нет, звёзды и номер продолжения остаются.
    await prisma.purchase.create({
      data: {
        purchaseId: ids.continuePurchase, accountId: ids.tester, product: "continue_run", runId: ids.run, continueNo: 1, elapsedSec: 120, priceStars: 4, chargedStars: 4,
        mode: "live", status: "paid", telegramChargeId: randomUUID(), invoicedAt: NOW, paidAt: NOW,
      },
    });
    // VIP-период остаётся.
    await prisma.purchase.create({
      data: {
        purchaseId: ids.vipPurchase, accountId: ids.tester, product: "vip", sku: "vip", priceStars: 700, chargedStars: 700, mode: "live", status: "paid",
        telegramChargeId: randomUUID(), invoicedAt: NOW, paidAt: NOW, fulfilledAt: NOW,
      },
    });
    await prisma.vipSubscription.create({ data: { subscriptionId: ids.vipPurchase, accountId: ids.tester, createdAt: NOW, updatedAt: NOW } });
    await prisma.vipPeriod.create({
      data: { purchaseId: ids.vipPurchase, subscriptionId: ids.vipPurchase, accountId: ids.tester, startsAt: NOW, endsAt: new Date(NOW.getTime() + 30 * 86_400_000), createdAt: NOW },
    });

    const [a, b] = ids.tester < ids.friend ? [ids.tester, ids.friend] : [ids.friend, ids.tester];
    await prisma.friendship.create({ data: { accountA: a, accountB: b, source: "link" } });
    await prisma.accountRestriction.create({ data: { accountId: ids.friend, kind: "leaderboard", startsAt: NOW, reason: "cheats", notify: false } });
  }

  const KEPT = ["Account", "Friendship", "AccountRestriction", "VipSubscription", "VipPeriod", "Purchase"] as const;

  it("подготовка: данные заведены (кейсы ниже идут по порядку)", async (ctx) => {
    if (skipReason !== "") return ctx.skip();
    await seed();

    expect(await prisma.account.count()).toBe(2);
  });

  it("planWipe: строки по моделям сходятся с заведёнными, снимок посчитан, ничего не изменилось", async (ctx) => {
    if (skipReason !== "") return ctx.skip();

    const plan = await planWipe(prisma, NOW);

    expect(plan.rows).toMatchObject({
      Account: 2, Run: 1, Item: 1, WalletBalance: 1, WalletDaily: 1, WalletEntry: 1, AccountProgress: 1, DailyReward: 1, Notification: 1,
      Purchase: 3, Friendship: 1, AccountRestriction: 1, VipSubscription: 1, VipPeriod: 1, TesterCompensation: 0, RunReward: 0, RunBoost: 0,
    });
    expect(Object.keys(plan.rows).sort()).toEqual(Object.keys(WIPE_PLAN).sort());
    expect(plan.snapshot).toEqual({ accounts: 1, testers: 1, bonusGems: 60, restored: { gems: 150 }, continueStars: 4 });
    expect(await prisma.run.count()).toBe(1);
    expect(await prisma.testerCompensation.count()).toBe(0);
    expect((await prisma.account.findUniqueOrThrow({ where: { accountId: ids.tester } })).testerAt).toBeNull();
  });

  it("сбой посреди транзакции: бросает, и не изменилось ничего — ни стёртого, ни снимка, ни обнулённой ссылки", async (ctx) => {
    if (skipReason !== "") return ctx.skip();
    const failing = (tx: Prisma.TransactionClient, model: Prisma.ModelName) => (model === "Item" ? Promise.reject(new Error("сбой")) : deleteAll(tx, model));

    await expect(runWipe(prisma, NOW, failing)).rejects.toThrow("сбой");

    expect(await prisma.run.count()).toBe(1);
    expect(await prisma.runReward.count()).toBe(0);
    expect(await prisma.item.count()).toBe(1);
    expect(await prisma.walletEntry.count()).toBe(1);
    expect(await prisma.accountProgress.count()).toBe(1);
    expect(await prisma.testerCompensation.count()).toBe(0);
    expect((await prisma.account.findUniqueOrThrow({ where: { accountId: ids.tester } })).testerAt).toBeNull();
    expect(await prisma.purchase.findUniqueOrThrow({ where: { purchaseId: ids.continuePurchase } })).toMatchObject({ runId: ids.run, continueNo: 1 });
  });

  it("транзакция вайпа получает долгий потолок запроса: стирание большой таблицы не упрётся в 15 секунд пула", async (ctx) => {
    if (skipReason !== "") return ctx.skip();
    let seen = "";
    const probing = async (tx: Prisma.TransactionClient, model: Prisma.ModelName) => {
      if (seen === "") seen = String((await tx.$queryRaw<{ statement_timeout: string }[]>`SHOW statement_timeout`)[0]?.statement_timeout);
      throw new Error(`проба ${model}`);
    };

    await expect(runWipe(prisma, NOW, probing)).rejects.toThrow("проба");

    expect(seen).toBe("10min");
  });

  it("runWipe: 18 моделей пусты, остальное на месте, у покупки второго шанса обнулён только run_id", async (ctx) => {
    if (skipReason !== "") return ctx.skip();

    const result = await runWipe(prisma, NOW);

    const after = await planWipe(prisma, NOW);
    for (const model of WIPE_ORDER) expect(after.rows[model], model).toBe(0);
    expect(WIPE_ORDER).toHaveLength(18);
    expect(after.rows).toMatchObject({ Account: 2, Friendship: 1, AccountRestriction: 1, VipSubscription: 1, VipPeriod: 1, Purchase: 3, TesterCompensation: 1 });
    expect(result.deleted).toMatchObject({ Run: 1, Item: 1, WalletEntry: 1, WalletBalance: 1, WalletDaily: 1, AccountProgress: 1, DailyReward: 1, Notification: 1, RunReward: 0 });
    expect(Object.keys(result.deleted)).toEqual([...WIPE_ORDER]);
    expect(result.snapshot).toEqual({ accounts: 1, testers: 1, bonusGems: 60, restored: { gems: 150 }, continueStars: 4 });

    expect(await prisma.purchase.findUniqueOrThrow({ where: { purchaseId: ids.continuePurchase } })).toMatchObject({
      runId: null, continueNo: 1, elapsedSec: 120, chargedStars: 4, status: "paid", telegramChargeId: expect.any(String) as string,
    });
    expect(await prisma.purchase.findUniqueOrThrow({ where: { purchaseId: ids.shopPurchase } })).toMatchObject({ chargedStars: 50, status: "paid" });
    expect(await prisma.vipPeriod.count({ where: { purchaseId: ids.vipPurchase } })).toBe(1);
    for (const model of KEPT) expect(after.rows[model], model).toBeGreaterThan(0);
  });

  it("строка компенсации: бонус 60 и выдача 150 самоцветов; тестеру поставлен знак", async (ctx) => {
    if (skipReason !== "") return ctx.skip();

    const rows = await prisma.testerCompensation.findMany();

    expect(rows).toEqual([
      { accountId: ids.tester, tester: true, level: 12, bonusGems: 60, grants: [{ purchaseId: ids.shopPurchase, resource: "gems", amount: 150 }], continueStars: 4, snapshotAt: NOW, claimedAt: null },
    ]);
    expect((await prisma.account.findUniqueOrThrow({ where: { accountId: ids.tester } })).testerAt).toEqual(NOW);
    expect((await prisma.account.findUniqueOrThrow({ where: { accountId: ids.friend } })).testerAt).toBeNull();
  });

  it("повторный runWipe: ошибка снимка, свежие данные не стёрты", async (ctx) => {
    if (skipReason !== "") return ctx.skip();
    await prisma.accountProgress.create({ data: { accountId: ids.tester, level: 2, updatedAt: NOW } });
    await prisma.run.create({
      data: { runId: randomUUID(), accountId: ids.tester, status: "finished", difficulty: "normal", startingWeaponId: "knife", contentHash: "abc", finishedAt: NOW },
    });

    await expect(runWipe(prisma, NOW)).rejects.toThrow("снимок компенсаций уже есть");

    expect(await prisma.accountProgress.count()).toBe(1);
    expect(await prisma.run.count()).toBe(1);
    expect(await prisma.testerCompensation.count()).toBe(1);
  });
});
