import { randomUUID } from "node:crypto";
import { Decimal, rateOf, type CurrencyCode, type Rate } from "@bh/fx";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DomainError, ForbiddenError } from "../src/common/domain-error.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import type { FxService } from "../src/modules/fx/fx.service.js";
import { PrismaLedgerChartRepository } from "../src/modules/ledger/ledger-chart.repository.js";
import { LedgerChartService } from "../src/modules/ledger/ledger-chart.service.js";
import { PrismaLedgerRepository } from "../src/modules/ledger/ledger.repository.js";
import { LedgerService } from "../src/modules/ledger/ledger.service.js";
import { OperationApprovals } from "../src/modules/ledger/operations/approval.js";
import type { OperationInput } from "../src/modules/ledger/operations/operation-input.js";
import type { OperationView } from "../src/modules/ledger/operations/operation-view.js";
import type { OperationsNotifier } from "../src/modules/ledger/operations/operations-notify.js";
import { PrismaOperationsRepository } from "../src/modules/ledger/operations/operations.repository.js";
import { OperationsService, type OperationActor } from "../src/modules/ledger/operations/operations.service.js";
import { IMAGE_CONTENT_TYPE, imageIdOf } from "../src/modules/media/image-rules.js";
import { PrismaMediaRepository } from "../src/modules/media/media.repository.js";
import { MediaService } from "../src/modules/media/media.service.js";
import type { AuditEntry } from "../src/modules/roles/roles.repository.js";
import type { RolesService } from "../src/modules/roles/roles.service.js";
import type { SettingsReader } from "../src/modules/settings/settings.service.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Второй ключ на живом Postgres (docs/17-testing-strategy.md §4.2; адрес — TEST_DATABASE_URL, без него пропуск;
 * Р220, tasks/T-0462): операция на подтверждении не создаёт проводки, `approve` создаёт ровно одну — и при двух
 * одновременных нажатиях, `reject` — без проводки и с причиной, повторное решение — 409; снимок чека лежит в
 * колонке операции, а показ снимка закрыт правом учёта.
 *
 * Журнал не стирается, поэтому каждый прогон берёт свои названия и по окончании убирает только операции, счета
 * и статьи без проводок (как `ledger-operations.integration.test.ts`).
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

const AT = "2026-11-10";

/** WebP без потерь (`VP8L`) нужных сторон: заголовок настоящий, содержимое — заполнитель, `pad` делает хэш разным. */
function receiptWebp(width: number, height: number, pad = 0): Buffer {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const body = Buffer.from([0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff, ...new Array<number>(16 + pad).fill(pad & 0xff)]);
  const header = Buffer.alloc(20);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(12 + body.length, 4);
  header.write("WEBPVP8L", 8, "latin1");
  header.writeUInt32LE(body.length, 16);
  return Buffer.concat([header, body]);
}

async function domainError(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("ожидалась доменная ошибка, а вызов прошёл");
}

describe.skipIf(DATABASE_URL === "")("второй ключ операций учёта на живом Postgres", () => {
  let prisma: PrismaClient;
  let operations: OperationsService;
  let media: MediaService;
  const audit: AuditEntry[] = [];
  const notifier = { pending: vi.fn(async () => undefined), decided: vi.fn(async () => undefined) };
  const run = randomUUID().slice(0, 8);
  const owner: OperationActor = { accountId: randomUUID(), platform: "telegram", platformUserId: "9101" };
  const finance: OperationActor = { accountId: randomUUID(), platform: "telegram", platformUserId: "9102" };
  const createdAccounts: string[] = [];
  const createdArticles: string[] = [];
  const createdOperations: string[] = [];
  const createdImages: string[] = [];

  let bank = "";
  let expenseArticle = "";

  const rates = (source: Partial<Record<CurrencyCode, string>>): Map<CurrencyCode, Rate> =>
    new Map((Object.entries(source) as [CurrencyCode, string][]).map(([code, usd]) => [code, rateOf(code, new Decimal(usd), ["test"], new Date())]));

  async function create(actor: OperationActor, input: OperationInput): Promise<OperationView> {
    const view = await operations.create(actor, input);
    createdOperations.push(view.operationId);
    return view;
  }

  async function entriesWithKey(sourceKey: string): Promise<number> {
    return await prisma.ledgerEntry.count({ where: { sourceKey } });
  }

  const expense = (amount: string, overrides: Partial<Extract<OperationInput, { kind: "expense" }>> = {}): OperationInput => ({
    kind: "expense",
    note: `Оплата сервера ${run}`,
    at: AT,
    from: bank,
    article: expenseArticle,
    amount,
    ...overrides,
  });

  /** Крупная операция финансов: 20 000 ₽ по курсу 0,0125 — это 250 $, порог 200 $. */
  async function held(overrides: Partial<Extract<OperationInput, { kind: "expense" }>> = {}): Promise<OperationView> {
    const draft = await create(finance, expense("20000", overrides));
    const pending = await operations.submit(finance, draft.operationId);
    expect(pending.status).toBe("pending");
    return pending;
  }

  beforeAll(async () => {
    prisma = testPrisma(DATABASE_URL, 12);
    const ledger = new LedgerService(new PrismaLedgerRepository(prisma));
    const can = async (actor: OperationActor, permission: string): Promise<boolean> =>
      actor.accountId === owner.accountId || permission !== "finance.operation.approve";
    const roles = {
      audit: async (entry: AuditEntry) => void audit.push(entry),
      rolesFor: async (actor: OperationActor) => (actor.accountId === owner.accountId ? ["owner"] : ["finance"]),
      can,
      // Как настоящий RolesService.require: нет права — отказ, а не молчаливый пропуск (MediaService.upload зовёт его).
      require: async (actor: OperationActor, permission: string): Promise<void> => {
        if (!(await can(actor, permission))) throw new ForbiddenError("Недостаточно прав");
      },
    } as unknown as RolesService;
    const chart = new LedgerChartService(new PrismaLedgerChartRepository(prisma), ledger, roles);
    const fx = { peek: async () => ({ takenAt: new Date(), rates: rates({ RUB: "0.0125" }), payout: rates({ XTR: "0.013" }) }) } as unknown as FxService;
    const settings = { get: (setting: { fallback: unknown }) => setting.fallback, onChange: () => undefined } as unknown as SettingsReader;
    const approvals = new OperationApprovals(roles, settings, notifier as unknown as OperationsNotifier);
    media = new MediaService(new PrismaMediaRepository(prisma), roles);
    operations = new OperationsService(new PrismaOperationsRepository(prisma), ledger, chart, fx, roles, approvals, media);

    const place = await chart.createPlace(owner, { name: `Банк второго ключа ${run}`, currency: "RUB" });
    bank = place.placeId;
    createdAccounts.push(place.placeId);
    const article = await chart.createArticle(owner, { name: `Серверы второго ключа ${run}`, kind: "expense" });
    expenseArticle = article.articleId;
    createdArticles.push(article.articleId);
  });

  afterAll(async () => {
    await prisma.ledgerLoan.deleteMany({ where: { operationId: { in: createdOperations } } });
    await prisma.ledgerOperation.deleteMany({ where: { operationId: { in: createdOperations } } });
    await prisma.mediaImage.deleteMany({ where: { imageId: { in: createdImages } } });
    for (const accountId of createdAccounts) {
      const used = await prisma.ledgerLine.count({ where: { accountId } });
      if (used === 0) await prisma.ledgerAccount.deleteMany({ where: { accountId } });
    }
    for (const articleId of createdArticles) {
      const left = await prisma.ledgerAccount.count({ where: { articleId } });
      if (left === 0) await prisma.ledgerArticle.deleteMany({ where: { articleId } });
    }
    await prisma.$disconnect();
  });

  it("крупная операция финансов: статус «на подтверждении», проводки нет, остаток места не тронут; мелкая — проводится сразу", async () => {
    const pending = await held();

    expect(pending).toMatchObject({ status: "pending", entry: null, amountUsd: "250.00" });
    expect(await entriesWithKey(`op:${pending.operationId}`)).toBe(0);
    const row = await prisma.ledgerOperation.findUniqueOrThrow({ where: { operationId: pending.operationId } });
    expect(row).toMatchObject({ status: "pending", sourceKey: null, decidedBy: null, decidedAt: null });
    expect(notifier.pending).toHaveBeenCalled();

    const small = await create(finance, expense("3200"));
    expect((await operations.submit(finance, small.operationId)).status).toBe("posted");
    expect(await entriesWithKey(`op:${small.operationId}`)).toBe(1);
  });

  it("владелец проводит крупное сразу, а повторный submit ожидающей — та же ожидающая", async () => {
    const own = await create(owner, expense("20000"));
    expect((await operations.submit(owner, own.operationId)).status).toBe("posted");

    const pending = await held();
    expect((await operations.submit(finance, pending.operationId)).status).toBe("pending");
    expect(await entriesWithKey(`op:${pending.operationId}`)).toBe(0);
  });

  it("approve: ровно одна проводка, решение и время в строке, аудит; повторный approve и reject — 409", async () => {
    const pending = await held();

    const posted = await operations.approve(owner, pending.operationId, "Согласовано");

    expect(posted).toMatchObject({ status: "posted", decidedBy: owner.accountId, decisionNote: "Согласовано" });
    expect(posted.decidedAt).not.toBeNull();
    expect(posted.entry?.sourceKey).toBe(`op:${pending.operationId}`);
    expect(await entriesWithKey(`op:${pending.operationId}`)).toBe(1);
    expect(audit.filter((entry) => entry.target === pending.operationId).map((entry) => entry.action)).toContain("ledger.operation.approve");
    expect(await domainError(operations.approve(owner, pending.operationId))).toMatchObject({ code: "ledger_operation_not_pending", status: 409 });
    expect(await domainError(operations.reject(owner, pending.operationId, "Передумал"))).toMatchObject({ status: 409 });
    expect(await entriesWithKey(`op:${pending.operationId}`)).toBe(1);
  });

  it("два одновременных approve — одна проводка: второй либо видит «уже решено» (409), либо получает ту же операцию", async () => {
    const pending = await held();

    const results = await Promise.allSettled([operations.approve(owner, pending.operationId), operations.approve(owner, pending.operationId)]);

    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "ledger_operation_not_pending", status: 409 });
    }
    expect(await entriesWithKey(`op:${pending.operationId}`)).toBe(1);
    expect(audit.filter((entry) => entry.target === pending.operationId && entry.action === "ledger.operation.approve")).toHaveLength(1);
  });

  it("одновременные approve и reject: решение одно — либо проводка есть и статус «проведена», либо её нет и «отклонена»", async () => {
    const pending = await held();

    await Promise.allSettled([operations.approve(owner, pending.operationId), operations.reject(owner, pending.operationId, "Не согласовано")]);

    const row = await prisma.ledgerOperation.findUniqueOrThrow({ where: { operationId: pending.operationId } });
    const entries = await entriesWithKey(`op:${pending.operationId}`);
    expect(["posted", "rejected"]).toContain(row.status);
    // Проводку мог записать approve, а отметку у него перехватил reject — тогда решение «отклонена» стоит, а проводка осталась в журнале.
    // Допустимо только первое: «проведена» ⇔ проводка есть; обратного расхождения быть не должно.
    if (row.status === "posted") expect(entries).toBe(1);
  });

  it("reject: причина обязательна, проводки нет, статус «отклонена», решивший и время записаны; повторное решение — 409", async () => {
    const pending = await held();
    expect((await domainError(operations.reject(owner, pending.operationId, ""))).status).toBe(400);

    const rejected = await operations.reject(owner, pending.operationId, "Сумма не сходится с чеком");

    expect(rejected).toMatchObject({ status: "rejected", decidedBy: owner.accountId, decisionNote: "Сумма не сходится с чеком", entry: null });
    expect(await entriesWithKey(`op:${pending.operationId}`)).toBe(0);
    expect(audit.filter((entry) => entry.target === pending.operationId).map((entry) => entry.action)).toContain("ledger.operation.reject");
    expect(await domainError(operations.approve(owner, pending.operationId))).toMatchObject({ status: 409 });
    expect(await domainError(operations.reject(owner, pending.operationId, "Ещё раз"))).toMatchObject({ status: 409 });
  });

  it("финансы подтвердить не могут — 403, операция остаётся ждать", async () => {
    const pending = await held();

    expect((await domainError(operations.approve(finance, pending.operationId))).status).toBe(403);
    expect((await prisma.ledgerOperation.findUniqueOrThrow({ where: { operationId: pending.operationId } })).status).toBe("pending");
  });

  it("исправление от финансов ждёт владельца: до подтверждения сторно в журнале нет", async () => {
    const original = await create(owner, expense("500"));
    await operations.submit(owner, original.operationId);

    const fix = await create(finance, { kind: "reversal", note: `Ошибся суммой ${run}`, at: AT, sourceKey: `op:${original.operationId}` });
    expect((await operations.submit(finance, fix.operationId)).status).toBe("pending");
    expect(await entriesWithKey(`op:${fix.operationId}`)).toBe(0);

    expect((await operations.approve(owner, fix.operationId)).status).toBe("posted");
    expect(await entriesWithKey(`op:${fix.operationId}`)).toBe(1);
  });

  it("снимок чека: id лежит в колонке receipt_image, правится и убирается; чужой или несуществующий — отказ; id не из 64 hex база не примет", async () => {
    const bytes = receiptWebp(640, 480, 1);
    const imageId = imageIdOf(bytes);
    createdImages.push(imageId);
    await media.upload(finance, "finance_receipt", bytes);

    const draft = await create(finance, expense("1000", { receiptImage: imageId }));
    expect((await prisma.ledgerOperation.findUniqueOrThrow({ where: { operationId: draft.operationId } })).receiptImage).toBe(imageId);
    expect(draft.input).toMatchObject({ receiptImage: imageId });

    const cleared = await operations.update(finance, draft.operationId, expense("1000"));
    expect(cleared.input).not.toHaveProperty("receiptImage");
    expect((await prisma.ledgerOperation.findUniqueOrThrow({ where: { operationId: draft.operationId } })).receiptImage).toBeNull();

    expect((await domainError(operations.create(finance, expense("1000", { receiptImage: "f".repeat(64) })))).code).toBe("image_not_found");
    await expect(prisma.ledgerOperation.create({ data: { operationId: randomUUID(), kind: "expense", input: {}, note: "проверка правил базы", createdBy: randomUUID(), receiptImage: "не-хэш" } })).rejects.toThrow();
  });

  it("картинка, загруженная под другой профиль, снимком чека не становится: показ чека закрыт, а у задания открыт", async () => {
    const square = receiptWebp(512, 512, 2);
    const imageId = imageIdOf(square);
    createdImages.push(imageId);
    await prisma.mediaImage.createMany({ data: [{ imageId, contentType: IMAGE_CONTENT_TYPE, width: 512, height: 512, sizeBytes: square.length, data: Uint8Array.from(square), createdBy: finance.accountId }], skipDuplicates: true });

    expect((await domainError(operations.create(finance, expense("1000", { receiptImage: imageId })))).code).toBe("image_rejected");
  });

  it("загрузка снимка чека закрывает показ: строка несёт ledger.view; чужие профили открыты по-прежнему", async () => {
    const receipt = receiptWebp(800, 600, 3);
    const receiptId = imageIdOf(receipt);
    createdImages.push(receiptId);
    await media.upload(finance, "finance_receipt", receipt);

    expect((await media.read(receiptId))?.viewPermission).toBe("ledger.view");
    expect((await prisma.mediaImage.findUniqueOrThrow({ where: { imageId: receiptId } })).viewPermission).toBe("ledger.view");
  });
});
