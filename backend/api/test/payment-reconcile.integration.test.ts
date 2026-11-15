import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import type { FoundDiscrepancy } from "../src/modules/payments/payment-reconcile.js";
import { PrismaPaymentReconcileRepository } from "../src/modules/payments/payment-reconcile.repository.js";
import { uniquePlatformUserId } from "./helpers/player-ids.js";

/**
 * Хранилище сверки оплат на настоящем Postgres (tasks/T-0433, Р209,
 * docs/17-testing-strategy.md §4.2). Адрес — TEST_DATABASE_URL; без него
 * пропускается.
 *
 * Память этого не покажет: уникальный ключ `(platform, kind, charge_id)` и
 * `skipDuplicates`, условия «только открытые», площадка аккаунта в запросе
 * окна и отбор обзора по срокам живут в запросах к базе.
 *
 * Все строки теста лежат в окне января 2031 года и несут общий префикс
 * идентификатора оплаты: прежние прогоны и другие тесты их не задевают, а
 * после теста строки удаляются.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

const PREFIX = `rc-${randomUUID().slice(0, 8)}-`;
const at = (day: number, minutes = 0): Date => new Date(Date.UTC(2031, 0, day, 10, minutes));
const charge = (name: string): string => `${PREFIX}${name}`;

function found(chargeId: string, patch: Partial<FoundDiscrepancy> = {}): FoundDiscrepancy {
  return { kind: "charged_unrecorded", chargeId, purchaseId: null, accountId: null, payerId: "555000111", amount: 50, payload: null, occurredAt: at(10), ...patch };
}

describe.skipIf(DATABASE_URL === "")("сверка оплат на живом Postgres", () => {
  let prisma: PrismaClient;
  let repository: PrismaPaymentReconcileRepository;
  let telegramAccount = "";
  let vkAccount = "";
  const runIds: string[] = [];
  const purchaseIds: string[] = [];

  async function startRun(platform: "telegram" | "vk" | "max", startedAt: Date, finish: { error?: string | null; toOffset?: number | null; finishedAt?: Date | null } = {}): Promise<string> {
    const runId = randomUUID();
    runIds.push(runId);
    await repository.startRun({ runId, platform, trigger: "schedule", actorAccountId: null, startedAt, fromOffset: 0 });
    if (finish.finishedAt !== null) {
      await repository.finishRun(runId, {
        finishedAt: finish.finishedAt ?? startedAt,
        toOffset: finish.toOffset === undefined ? 100 : finish.toOffset,
        coveredFrom: null,
        coveredTo: null,
        scanned: 100,
        found: 0,
        matched: 0,
        error: finish.error ?? null,
      });
    }
    return runId;
  }

  async function purchase(accountId: string, chargeId: string | null, paidAt: Date | null, patch: Record<string, unknown> = {}): Promise<string> {
    const purchaseId = randomUUID();
    purchaseIds.push(purchaseId);
    await prisma.purchase.create({
      data: {
        purchaseId,
        accountId,
        product: "shop_item",
        sku: "starter_pack",
        priceStars: 50,
        chargedStars: 50,
        mode: "live",
        status: paidAt === null ? "pending" : "paid",
        telegramChargeId: chargeId,
        invoicedAt: at(1),
        paidAt,
        ...patch,
      },
    });
    return purchaseId;
  }

  async function cleanup(): Promise<void> {
    await prisma.paymentDiscrepancy.deleteMany({ where: { chargeId: { startsWith: PREFIX } } });
    await prisma.paymentReconcileRun.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.purchase.deleteMany({ where: { purchaseId: { in: purchaseIds } } });
  }

  beforeAll(async () => {
    prisma = createPrisma(loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv));
    repository = new PrismaPaymentReconcileRepository(prisma);
    const accounts = new PrismaAccountRepository(prisma);
    const arrival = (platform: "telegram" | "vk", name: string) => ({ platform, platformUserId: uniquePlatformUserId(), displayName: name, username: null, photoUrl: null });
    telegramAccount = (await accounts.upsert(arrival("telegram", "Стрелок"), Date.now())).accountId;
    vkAccount = (await accounts.upsert(arrival("vk", "Лучник"), Date.now())).accountId;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("insertFound дважды с теми же находками — второй раз вставлено 0; уникальный ключ — площадка, вид, оплата", async () => {
    const runId = await startRun("telegram", at(2));
    const batch = [found(charge("a")), found(charge("b"), { kind: "refund_unrecorded" }), found(charge("c"), { kind: "recorded_missing", payerId: null })];

    const first = await repository.insertFound(runId, "telegram", batch, at(2, 5));
    const second = await repository.insertFound(runId, "telegram", batch, at(3, 5));

    expect(first.inserted).toBe(3);
    expect(first.items.map((item) => [item.kind, item.chargeId]).sort()).toEqual(
      [
        ["charged_unrecorded", charge("a")],
        ["refund_unrecorded", charge("b")],
        ["recorded_missing", charge("c")],
      ].sort(),
    );
    expect(second).toEqual({ inserted: 0, items: [] });
    expect(await prisma.paymentDiscrepancy.count({ where: { chargeId: { startsWith: PREFIX } } })).toBe(3);
  });

  it("тот же номер оплаты другого вида или другой площадки — отдельная строка", async () => {
    const runId = await startRun("telegram", at(2, 10));

    const inserted = await repository.insertFound(runId, "telegram", [found(charge("a"), { kind: "refund_unrecorded" })], at(2, 15));
    const other = await repository.insertFound(runId, "vk", [found(charge("a"))], at(2, 15));

    expect(inserted.inserted).toBe(1);
    expect(other.inserted).toBe(1);
    expect(await prisma.paymentDiscrepancy.count({ where: { chargeId: charge("a") } })).toBe(3);
  });

  it("строка хранит поля находки; detectedAt — время вставки, payload — как пришёл, покупка и аккаунт — без внешних ключей", async () => {
    const runId = await startRun("telegram", at(2, 20));
    const ghostPurchase = randomUUID();
    const ghostAccount = randomUUID();
    const longPayload = "я".repeat(128);

    await repository.insertFound(runId, "telegram", [found(charge("full"), { purchaseId: ghostPurchase, accountId: ghostAccount, amount: 75, payload: longPayload, occurredAt: at(9, 30) })], at(2, 25));

    expect(await prisma.paymentDiscrepancy.findFirst({ where: { chargeId: charge("full") } })).toMatchObject({
      platform: "telegram",
      kind: "charged_unrecorded",
      purchaseId: ghostPurchase,
      accountId: ghostAccount,
      payerId: "555000111",
      amount: 75,
      payload: longPayload,
      occurredAt: at(9, 30),
      detectedAt: at(2, 25),
      runId,
      resolvedAt: null,
      resolution: null,
    });
  });

  it("длинный идентификатор оплаты (131 знак, сбой 11.11.2026) ложится целиком", async () => {
    const runId = await startRun("telegram", at(2, 30));
    const long = `${PREFIX}stx${"0123456789abcdef".repeat(8)}`;

    await repository.insertFound(runId, "telegram", [found(long)], at(2, 35));

    expect((await prisma.paymentDiscrepancy.findFirst({ where: { chargeId: long } }))?.chargeId).toBe(long);
  });

  it("resolveMatched закрывает только открытые: закрытые руками остаются как были", async () => {
    const runId = await startRun("telegram", at(4));
    await repository.insertFound(runId, "telegram", [found(charge("m1")), found(charge("m2")), found(charge("m3"))], at(4, 5));
    const rows = await prisma.paymentDiscrepancy.findMany({ where: { chargeId: { in: [charge("m1"), charge("m2"), charge("m3")] }, platform: "telegram" } });
    const byCharge = new Map(rows.map((row) => [row.chargeId, row.discrepancyId]));
    await prisma.paymentDiscrepancy.update({ where: { discrepancyId: byCharge.get(charge("m3")) ?? "" }, data: { resolvedAt: at(4, 6), resolution: "dismissed", note: "ложное" } });

    const closed = await repository.resolveMatched([...byCharge.values()], at(5));

    expect(closed).toBe(2);
    const after = await prisma.paymentDiscrepancy.findMany({ where: { chargeId: { in: [charge("m1"), charge("m2"), charge("m3")] }, platform: "telegram" }, orderBy: { chargeId: "asc" } });
    expect(after.map((row) => [row.chargeId, row.resolution, row.resolvedAt?.getTime()])).toEqual([
      [charge("m1"), "matched", at(5).getTime()],
      [charge("m2"), "matched", at(5).getTime()],
      [charge("m3"), "dismissed", at(4, 6).getTime()],
    ]);
  });

  it("resolveMatched с пустым списком — ничего не трогает", async () => {
    expect(await repository.resolveMatched([], at(5))).toBe(0);
  });

  it("open — открытые расхождения площадки: ни закрытых, ни чужой площадки", async () => {
    const runId = await startRun("telegram", at(6));
    await repository.insertFound(runId, "telegram", [found(charge("o1")), found(charge("o2"), { kind: "refund_unrecorded" })], at(6, 5));
    await repository.insertFound(runId, "vk", [found(charge("o3"))], at(6, 5));
    await prisma.paymentDiscrepancy.updateMany({ where: { chargeId: charge("o2") }, data: { resolvedAt: at(6, 10), resolution: "matched" } });

    const open = (await repository.open("telegram")).filter((row) => row.chargeId.startsWith(PREFIX));

    expect(open.map((row) => row.chargeId)).toContain(charge("o1"));
    expect(open.map((row) => row.chargeId)).not.toContain(charge("o2"));
    expect(open.map((row) => row.chargeId)).not.toContain(charge("o3"));
  });

  describe("покупки", () => {
    it("purchasesByCharges — покупки по номерам оплат: аккаунт, сумма, время оплаты и возврата; длинный номер находится", async () => {
      const longCharge = `${PREFIX}stx${"0123456789abcdef".repeat(8)}-p`;
      const first = await purchase(telegramAccount, charge("p1"), at(8, 5), { chargedStars: 75, refundedAt: at(8, 50), status: "refunded" });
      const second = await purchase(telegramAccount, longCharge, at(8, 6));
      await purchase(telegramAccount, charge("p-other"), at(8, 7));

      const rows = await repository.purchasesByCharges([charge("p1"), longCharge, charge("p-нет")]);

      expect(rows.sort((a, b) => a.chargeId.localeCompare(b.chargeId))).toEqual(
        [
          { purchaseId: first, accountId: telegramAccount, chargeId: charge("p1"), chargedStars: 75, paidAt: at(8, 5), refundedAt: at(8, 50) },
          { purchaseId: second, accountId: telegramAccount, chargeId: longCharge, chargedStars: 50, paidAt: at(8, 6), refundedAt: null },
        ].sort((a, b) => a.chargeId.localeCompare(b.chargeId)),
      );
    });

    it("purchasesByCharges с пустым списком и со списком длиннее одной порции", async () => {
      expect(await repository.purchasesByCharges([])).toEqual([]);
      const many = Array.from({ length: 2500 }, (_, index) => `${PREFIX}нет-${String(index)}`);

      expect(await repository.purchasesByCharges(many)).toEqual([]);
    });

    it("purchasesByIds — аккаунт по id покупки; несуществующих нет", async () => {
      const id = await purchase(telegramAccount, null, null);

      expect(await repository.purchasesByIds([id, randomUUID()])).toEqual([{ purchaseId: id, accountId: telegramAccount }]);
      expect(await repository.purchasesByIds([])).toEqual([]);
    });

    it("paidInWindow не берёт покупки аккаунтов другой площадки, без номера оплаты и вне отрезка", async () => {
      const inside = await purchase(telegramAccount, charge("w-in"), at(12, 30));
      await purchase(telegramAccount, charge("w-early"), at(12, 5));
      await purchase(telegramAccount, charge("w-late"), at(12, 55));
      await purchase(vkAccount, charge("w-vk"), at(12, 30));
      await purchase(telegramAccount, null, at(12, 31));
      const edgeFrom = await purchase(telegramAccount, charge("w-from"), at(12, 10));
      const edgeTo = await purchase(telegramAccount, charge("w-to"), at(12, 50));

      const rows = await repository.paidInWindow("telegram", at(12, 10), at(12, 50));

      expect(rows.map((row) => row.purchaseId).sort()).toEqual([inside, edgeFrom, edgeTo].sort());
      expect(rows.find((row) => row.purchaseId === inside)).toEqual({ purchaseId: inside, accountId: telegramAccount, chargeId: charge("w-in"), chargedStars: 50, paidAt: at(12, 30), refundedAt: null });
      expect((await repository.paidInWindow("vk", at(12, 10), at(12, 50))).map((row) => row.chargeId)).toEqual([charge("w-vk")]);
    });
  });

  describe("сверки", () => {
    it("lastFinished — последняя удачная: оборванные и с ошибкой не в счёт", async () => {
      await startRun("max", at(14), { finishedAt: at(14, 5), toOffset: 120 });
      await startRun("max", at(15), { finishedAt: at(15, 5), toOffset: 340 });
      await startRun("max", at(16), { finishedAt: at(16, 5), toOffset: null, error: "Bad Gateway" });
      await startRun("max", at(17), { finishedAt: null });

      expect(await repository.lastFinished("max")).toEqual({ toOffset: 340, finishedAt: at(15, 5) });
    });

    it("finishRun пишет итог: курсор, отрезок, счётчики, ошибка — как передана", async () => {
      const runId = await startRun("vk", at(18), { finishedAt: null });

      await repository.finishRun(runId, { finishedAt: at(18, 3), toOffset: 77, coveredFrom: at(17, 1), coveredTo: at(18, 1), scanned: 77, found: 2, matched: 1, error: null });

      expect(await prisma.paymentReconcileRun.findUnique({ where: { runId } })).toMatchObject({
        platform: "vk",
        trigger: "schedule",
        actorAccountId: null,
        startedAt: at(18),
        finishedAt: at(18, 3),
        fromOffset: 0,
        toOffset: 77,
        coveredFrom: at(17, 1),
        coveredTo: at(18, 1),
        scanned: 77,
        found: 2,
        matched: 1,
        error: null,
      });
    });
  });

  describe("действия по расхождениям (tasks/T-0434)", () => {
    /** Расхождение в базе: вставляется как находка сверки, а читается обратно — так проверяется и запись, и чтение. */
    async function insert(name: string, patch: Partial<FoundDiscrepancy> = {}, detectedAt = at(29, 5)): Promise<string> {
      const runId = await startRun("telegram", at(29));
      await repository.insertFound(runId, "telegram", [found(charge(name), patch)], detectedAt);
      const row = await prisma.paymentDiscrepancy.findFirst({ where: { platform: "telegram", chargeId: charge(name) } });
      if (row === null) throw new Error("расхождение не вставилось");
      return row.discrepancyId;
    }

    it("два одновременных claim одного расхождения — ровно один true: занявший пишет решение, актёра, причину и время", async () => {
      const id = await insert("claim-race");
      const first = randomUUID();
      const second = randomUUID();

      const results = await Promise.all([repository.claim(id, "retried", first, "повтор по выписке", at(30, 1)), repository.claim(id, "dismissed", second, "ложное", at(30, 2))]);

      expect(results.filter((result) => result)).toHaveLength(1);
      const winner = results[0] ? { resolution: "retried", resolvedBy: first, note: "повтор по выписке", resolvedAt: at(30, 1) } : { resolution: "dismissed", resolvedBy: second, note: "ложное", resolvedAt: at(30, 2) };
      expect(await prisma.paymentDiscrepancy.findUnique({ where: { discrepancyId: id } })).toMatchObject(winner);
    });

    it("claim закрытого — false, прежнее решение не меняется; claim несуществующего — false", async () => {
      const id = await insert("claim-closed");
      const actor = randomUUID();
      await prisma.paymentDiscrepancy.update({ where: { discrepancyId: id }, data: { resolvedAt: at(30, 3), resolution: "matched" } });

      expect(await repository.claim(id, "dismissed", actor, "поздно", at(30, 4))).toBe(false);
      expect(await repository.claim(randomUUID(), "dismissed", actor, "нет такого", at(30, 4))).toBe(false);

      expect(await prisma.paymentDiscrepancy.findUnique({ where: { discrepancyId: id } })).toMatchObject({ resolution: "matched", resolvedAt: at(30, 3), resolvedBy: null, note: null });
    });

    it("byId — строка расхождения целиком, закрытая тоже; нет такого — null", async () => {
      const purchaseId = randomUUID();
      const id = await insert("by-id", { purchaseId, accountId: telegramAccount, amount: 75, payload: "счёт", occurredAt: at(28, 9) });

      expect(await repository.byId(id)).toEqual({
        discrepancyId: id,
        platform: "telegram",
        kind: "charged_unrecorded",
        chargeId: charge("by-id"),
        purchaseId,
        accountId: telegramAccount,
        payerId: "555000111",
        amount: 75,
        payload: "счёт",
        occurredAt: at(28, 9),
        detectedAt: at(29, 5),
        resolution: null,
        resolvedAt: null,
        resolvedBy: null,
        note: null,
      });
      expect(await repository.claim(id, "refunded", telegramAccount, "вернули", at(30, 5))).toBe(true);
      expect(await repository.byId(id)).toMatchObject({ resolution: "refunded", resolvedAt: at(30, 5), resolvedBy: telegramAccount, note: "вернули" });
      expect(await repository.byId(randomUUID())).toBeNull();
    });

    it("byPurchase — все расхождения покупки, открытые и закрытые, по времени обнаружения; чужих нет", async () => {
      const purchaseId = randomUUID();
      const late = await insert("by-purchase-late", { purchaseId, kind: "refund_unrecorded" }, at(29, 30));
      const early = await insert("by-purchase-early", { purchaseId }, at(29, 10));
      await insert("by-purchase-other", { purchaseId: randomUUID() });
      await repository.claim(early, "dismissed", telegramAccount, "ложное", at(30, 6));

      const rows = await repository.byPurchase(purchaseId);

      expect(rows.map((row) => row.discrepancyId)).toEqual([early, late]);
      expect(await repository.byPurchase(randomUUID())).toEqual([]);
    });

    it("openByPurchases — только открытые по списку покупок; пустой список и список длиннее одной порции", async () => {
      const mine = randomUUID();
      const closed = randomUUID();
      const other = randomUUID();
      const openOne = await insert("open-by-mine", { purchaseId: mine });
      const closedOne = await insert("open-by-closed", { purchaseId: closed });
      await insert("open-by-other", { purchaseId: other });
      await repository.claim(closedOne, "dismissed", telegramAccount, "ложное", at(30, 7));

      const rows = await repository.openByPurchases([mine, closed, randomUUID()]);

      expect(rows.map((row) => row.discrepancyId)).toEqual([openOne]);
      expect(await repository.openByPurchases([])).toEqual([]);
      const many = Array.from({ length: 2500 }, () => randomUUID());
      expect(await repository.openByPurchases([...many, mine])).toHaveLength(1);
    });
  });

  describe("overview", () => {
    it("открытые, закрытые за 30 суток и последняя сверка площадки; свежие первыми", async () => {
      const now = at(25);
      const runId = await startRun("vk", at(24), { finishedAt: at(24, 4), toOffset: 10 });
      await startRun("vk", at(25, -30), { finishedAt: at(25, -27), toOffset: null, error: "Bad Gateway" });
      await repository.insertFound(runId, "telegram", [found(charge("ov-open-old")), found(charge("ov-done-new")), found(charge("ov-done-old")), found(charge("ov-done-ancient"))], at(20, 1));
      await repository.insertFound(runId, "telegram", [found(charge("ov-open-new"))], at(21, 1));
      await prisma.paymentDiscrepancy.updateMany({ where: { chargeId: charge("ov-done-new") }, data: { resolvedAt: at(24), resolution: "dismissed", note: "ложное" } });
      await prisma.paymentDiscrepancy.updateMany({ where: { chargeId: charge("ov-done-old") }, data: { resolvedAt: at(23), resolution: "matched" } });
      // Закрыто больше тридцати суток назад: в обзор не входит.
      await prisma.paymentDiscrepancy.updateMany({ where: { chargeId: charge("ov-done-ancient") }, data: { resolvedAt: new Date(Date.UTC(2030, 11, 1)), resolution: "matched" } });

      const view = await repository.overview(now);

      expect(view.open.filter((row) => row.chargeId.startsWith(PREFIX + "ov-")).map((row) => row.chargeId)).toEqual([charge("ov-open-new"), charge("ov-open-old")]);
      expect(view.resolved.filter((row) => row.chargeId.startsWith(PREFIX + "ov-")).map((row) => [row.chargeId, row.resolution, row.note])).toEqual([
        [charge("ov-done-new"), "dismissed", "ложное"],
        [charge("ov-done-old"), "matched", null],
      ]);
      const vkRun = view.lastRuns.find((row) => row.platform === "vk");
      expect(vkRun).toMatchObject({ startedAt: at(25, -30), error: "Bad Gateway" });
    });

    it("закрытых — не больше ста", async () => {
      const runId = await startRun("telegram", at(26));
      const batch = Array.from({ length: 105 }, (_, index) => found(charge(`cap-${String(index).padStart(3, "0")}`)));
      await repository.insertFound(runId, "telegram", batch, at(26, 1));
      await prisma.paymentDiscrepancy.updateMany({ where: { chargeId: { startsWith: charge("cap-") } }, data: { resolvedAt: at(27), resolution: "matched" } });

      const view = await repository.overview(at(28));

      expect(view.resolved.length).toBeLessThanOrEqual(100);
    });
  });
});
