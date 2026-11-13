import { randomUUID } from "node:crypto";
import { Decimal, rateOf, type CurrencyCode, type Rate, type RatesSnapshot } from "@bh/fx";
import { describe, expect, it, vi } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import type { FxService } from "../src/modules/fx/fx.service.js";
import type { ArticleView, PlaceView } from "../src/modules/ledger/ledger-chart.js";
import type { LedgerChartService } from "../src/modules/ledger/ledger-chart.service.js";
import type { LedgerPostInput, LedgerService, PostResult } from "../src/modules/ledger/ledger.service.js";
import { OperationApprovals, needsApproval } from "../src/modules/ledger/operations/approval.js";
import type { OperationInput } from "../src/modules/ledger/operations/operation-input.js";
import { OperationsNotifier, decidedText, operationSummary, pendingText, type OperationCard } from "../src/modules/ledger/operations/operations-notify.js";
import type { DraftPatch, InsertOutcome, NewLoan, NewOperation, OperationFilter, OperationsRepository, PostedOutcome, StoredLoan, StoredOperation, StoredOperationEntry } from "../src/modules/ledger/operations/operations.repository.js";
import { OperationsService, type OperationActor } from "../src/modules/ledger/operations/operations.service.js";
import type { MediaService } from "../src/modules/media/media.service.js";
import { IMAGE_PROFILES } from "../src/modules/media/image-rules.js";
import { PERMISSIONS, ROLE_PERMISSIONS } from "../src/modules/roles/permissions.js";
import type { AuditEntry } from "../src/modules/roles/roles.repository.js";
import type { RolesService } from "../src/modules/roles/roles.service.js";
import { SETTINGS, settingByKey } from "../src/modules/settings/setting-catalog.js";
import type { SettingsReader } from "../src/modules/settings/settings.service.js";
import type { Messengers } from "../src/platforms/ports/messenger.js";

/**
 * Второй ключ на крупные операции финансов (Р220, tasks/T-0462; docs/29-admin-panel.md §4, «Правило двух ключей»):
 * правило «ждёт ли операция владельца» — чистая функция; сервис — на подменённых репозитории, журнале и курсах:
 * операция на подтверждении проводок не создаёт, решение владельца проводит ровно один раз; уведомление в поток
 * «Бухгалтерия» не блокирует и не роняет действие. Как это ложится на таблицы и гонки базы —
 * `ledger-approval.integration.test.ts`.
 */

const NOW = new Date("2026-11-13T12:00:00Z");
const OWNER: OperationActor = { accountId: "00000000-0000-4000-8000-000000000001", platform: "telegram", platformUserId: "1" };
const FINANCE: OperationActor = { accountId: "00000000-0000-4000-8000-000000000002", platform: "telegram", platformUserId: "2" };

describe("needsApproval: ждёт ли операция владельца", () => {
  const base = { kind: "expense", amountUsd: "40.00", actorCanApprove: false, thresholdUsd: 200 } as const;

  it("у кого есть право подтверждать — проводится сразу: и крупная, и без оценки, и исправление", () => {
    expect(needsApproval({ ...base, actorCanApprove: true, amountUsd: "100000.00" })).toBe(false);
    expect(needsApproval({ ...base, actorCanApprove: true, amountUsd: null })).toBe(false);
    expect(needsApproval({ ...base, actorCanApprove: true, kind: "reversal" })).toBe(false);
  });

  it("финансы: ниже порога — сразу, ровно порог и выше — ждёт", () => {
    expect(needsApproval({ ...base, amountUsd: "199.99" })).toBe(false);
    expect(needsApproval({ ...base, amountUsd: "200.00" })).toBe(true);
    expect(needsApproval({ ...base, amountUsd: "200" })).toBe(true);
    expect(needsApproval({ ...base, amountUsd: "250.00" })).toBe(true);
    expect(needsApproval({ ...base, amountUsd: "0.00" })).toBe(false);
  });

  it("порог берётся из настройки: другой порог — другая граница; порог ноль — ждёт всё", () => {
    expect(needsApproval({ ...base, amountUsd: "150.00", thresholdUsd: 100 })).toBe(true);
    expect(needsApproval({ ...base, amountUsd: "150.00", thresholdUsd: 100_000 })).toBe(false);
    expect(needsApproval({ ...base, amountUsd: "0.00", thresholdUsd: 0 })).toBe(true);
  });

  it("без оценки в долларах — ждёт: неизвестное не мелочь", () => {
    expect(needsApproval({ ...base, amountUsd: null })).toBe(true);
  });

  it("исправление от финансов ждёт всегда, даже с малой оценкой", () => {
    expect(needsApproval({ ...base, kind: "reversal", amountUsd: "1.00" })).toBe(true);
    expect(needsApproval({ ...base, kind: "reversal", amountUsd: null })).toBe(true);
  });

  it("повреждённая оценка — тоже «ждёт»: сравнивать нечем", () => {
    expect(needsApproval({ ...base, amountUsd: "не число" })).toBe(true);
  });
});

describe("право, настройки и профиль картинки", () => {
  it("finance.operation.approve — только у владельца: финансы вносят, но не подтверждают", () => {
    expect(PERMISSIONS).toContain("finance.operation.approve");
    expect(Object.entries(ROLE_PERMISSIONS).filter(([, granted]) => granted.includes("finance.operation.approve")).map(([role]) => role)).toEqual(["owner"]);
  });

  it("порог подтверждения: 200 по умолчанию, от 0 до 100 000, целое", () => {
    const setting = settingByKey("finance.approve-threshold-usd");
    expect(setting).toBeDefined();
    expect(setting?.fallback).toBe(200);
    expect(setting?.kind).toBe("number");
    expect(setting?.range).toMatchObject({ min: 0, max: 100_000 });
    expect(setting?.schema.safeParse(0).success).toBe(true);
    expect(setting?.schema.safeParse(100_000).success).toBe(true);
    expect(setting?.schema.safeParse(100_001).success).toBe(false);
    expect(setting?.schema.safeParse(-1).success).toBe(false);
    expect(setting?.schema.safeParse(10.5).success).toBe(false);
  });

  it("поток чата «Бухгалтерия»: notify.chat.finance, без окружения, пусто — общий чат", () => {
    const setting = settingByKey("notify.chat.finance");
    expect(setting).toBeDefined();
    expect(setting?.kind).toBe("chat");
    expect(setting?.title).toBe("Бухгалтерия");
    expect(setting?.fallback).toBe("");
    expect(setting?.schema.safeParse("-1001234567890:57").success).toBe(true);
  });

  it("профиль finance_receipt: не квадрат, сторона 300…1600, загрузка — finance.entry.create, показ — ledger.view", () => {
    expect(IMAGE_PROFILES.finance_receipt).toMatchObject({ square: false, minSide: 300, maxSide: 1_600, permission: "finance.entry.create", viewPermission: "ledger.view" });
  });
});

// ---- Подмены для сервиса ----

const BANK = "bank.rub";
const PLACE_VIEWS: PlaceView[] = [
  { placeId: BANK, name: "Банк, ₽", currency: "RUB", archived: false, balance: "0", fee: null, accounts: [{ accountId: BANK, name: "Банк, ₽", balance: "0" }] },
  { placeId: "bank.tbank", name: "Карта Т-Банка", currency: "RUB", archived: false, balance: "0", fee: null, accounts: [{ accountId: "bank.tbank", name: "Карта Т-Банка", balance: "0" }] },
];
const ARTICLE_VIEWS: ArticleView[] = [{ articleId: "vps", kind: "expense", name: "Сервер (VPS)", system: false, archived: false }];

class FakeLedger {
  readonly entries = new Map<string, { entryId: string; lines: LedgerPostInput["lines"] }>();
  postCalls = 0;

  async post(input: LedgerPostInput): Promise<PostResult> {
    this.postCalls += 1;
    const existing = this.entries.get(input.sourceKey);
    if (existing !== undefined) return { entryId: existing.entryId, created: false };
    const entryId = randomUUID();
    this.entries.set(input.sourceKey, { entryId, lines: input.lines });
    return { entryId, created: true };
  }

  async reverse(sourceKey: string, newSourceKey: string): Promise<PostResult> {
    if (!this.entries.has(sourceKey)) throw new Error(`нет проводки ${sourceKey}`);
    return await this.post({ sourceKey: newSourceKey, at: NOW, memo: "сторно", lines: [] });
  }

  forgetAccounts(): void {}
}

class FakeChart {
  async places(): Promise<PlaceView[]> {
    return PLACE_VIEWS;
  }

  async articles(): Promise<ArticleView[]> {
    return ARTICLE_VIEWS;
  }

  async ensureArticleAccount(articleId: string, currency: string): Promise<string> {
    return `expense.${articleId}.${currency}`;
  }
}

class MemoryOperations implements OperationsRepository {
  readonly rows = new Map<string, StoredOperation>();
  /** ключи проводок, которые уже лежат в журнале: ими же отвечает `entryExists` */
  constructor(private readonly ledger: FakeLedger) {}

  async insert(operation: NewOperation): Promise<InsertOutcome> {
    this.rows.set(operation.operationId, {
      operationId: operation.operationId,
      kind: operation.kind,
      status: "draft",
      input: operation.input,
      note: operation.note,
      link: operation.link,
      receiptImage: operation.receiptImage,
      amountUsd: operation.amountUsd,
      sourceKey: null,
      createdBy: operation.createdBy,
      createdAt: NOW,
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      templateId: operation.templateId,
      templatePeriod: operation.templatePeriod,
    });
    return "inserted";
  }

  async byId(operationId: string): Promise<StoredOperation | null> {
    const row = this.rows.get(operationId);
    return row === undefined ? null : { ...row };
  }

  async updateDraft(operationId: string, patch: DraftPatch): Promise<boolean> {
    const row = this.rows.get(operationId);
    if (row === undefined || row.status !== "draft") return false;
    this.rows.set(operationId, { ...row, ...patch });
    return true;
  }

  async deleteDraft(operationId: string): Promise<boolean> {
    const row = this.rows.get(operationId);
    if (row === undefined || row.status !== "draft") return false;
    return this.rows.delete(operationId);
  }

  async list(filter: OperationFilter): Promise<StoredOperation[]> {
    return [...this.rows.values()].filter((row) => filter.status === undefined || row.status === filter.status);
  }

  async entryExists(sourceKey: string): Promise<boolean> {
    return this.ledger.entries.has(sourceKey);
  }

  async markPending(operationId: string): Promise<boolean> {
    const row = this.rows.get(operationId);
    if (row === undefined || row.status !== "draft") return false;
    this.rows.set(operationId, { ...row, status: "pending" });
    return true;
  }

  async markPosted(operationId: string, sourceKey: string, _loan: NewLoan | null, decision?: { by: string; note: string | null }): Promise<PostedOutcome> {
    const row = this.rows.get(operationId);
    if (row === undefined) return "missing";
    if (row.status !== (decision === undefined ? "draft" : "pending")) return "already";
    this.rows.set(operationId, {
      ...row,
      status: "posted",
      sourceKey,
      ...(decision === undefined ? {} : { decidedBy: decision.by, decidedAt: NOW, decisionNote: decision.note }),
    });
    return "posted";
  }

  async reject(operationId: string, decision: { by: string; note: string }): Promise<boolean> {
    const row = this.rows.get(operationId);
    if (row === undefined || row.status !== "pending") return false;
    this.rows.set(operationId, { ...row, status: "rejected", decidedBy: decision.by, decidedAt: NOW, decisionNote: decision.note });
    return true;
  }

  async ensureAccount(): Promise<boolean> {
    return false;
  }

  async entriesBySource(): Promise<Map<string, StoredOperationEntry>> {
    return new Map();
  }

  async loansOf(): Promise<Map<string, StoredLoan>> {
    return new Map();
  }
}

function rates(source: Partial<Record<CurrencyCode, string>>): Map<CurrencyCode, Rate> {
  return new Map((Object.entries(source) as [CurrencyCode, string][]).map(([code, usd]) => [code, rateOf(code, new Decimal(usd), ["test"], NOW)]));
}

interface Harness {
  service: OperationsService;
  repository: MemoryOperations;
  ledger: FakeLedger;
  audit: AuditEntry[];
  notifier: { pending: ReturnType<typeof vi.fn>; decided: ReturnType<typeof vi.fn> };
  fx: { rates: Partial<Record<CurrencyCode, string>> };
  threshold: { value: number };
  media: { require: ReturnType<typeof vi.fn> };
}

function harness(): Harness {
  const ledger = new FakeLedger();
  const repository = new MemoryOperations(ledger);
  const audit: AuditEntry[] = [];
  const fx = { rates: { RUB: "0.0125" } as Partial<Record<CurrencyCode, string>> };
  const threshold = { value: 200 };
  const roles = {
    audit: async (entry: AuditEntry) => void audit.push(entry),
    rolesFor: async (actor: OperationActor) => (actor.accountId === OWNER.accountId ? ["owner"] : ["finance"]),
    can: async (actor: OperationActor, permission: string) => actor.accountId === OWNER.accountId || permission !== "finance.operation.approve",
  } as unknown as RolesService;
  const settings = {
    get: (setting: { key: string; fallback: unknown }) => (setting.key === SETTINGS.financeApproveThresholdUsd.key ? threshold.value : setting.fallback),
    onChange: () => undefined,
  } as unknown as SettingsReader;
  const notifier = { pending: vi.fn(async () => undefined), decided: vi.fn(async () => undefined) };
  const approvals = new OperationApprovals(roles, settings, notifier as unknown as OperationsNotifier);
  const media = { require: vi.fn(async () => undefined) };
  const fxService = { peek: async () => ({ takenAt: NOW, rates: rates(fx.rates), payout: new Map() }) satisfies Omit<RatesSnapshot, "id"> };
  const service = new OperationsService(
    repository,
    ledger as unknown as LedgerService,
    new FakeChart() as unknown as LedgerChartService,
    fxService as unknown as FxService,
    roles,
    approvals,
    media as unknown as MediaService,
  );
  return { service, repository, ledger, audit, notifier, fx, threshold, media };
}

const AT = "2026-11-10";
const expense = (amount: string, extra: Partial<Extract<OperationInput, { kind: "expense" }>> = {}): OperationInput => ({ kind: "expense", note: "Оплата сервера", at: AT, from: BANK, article: "vps", amount, ...extra });

async function domainError(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("ожидалась доменная ошибка, а вызов прошёл");
}

describe("OperationsService: второй ключ", () => {
  it("финансы, 250 $ (20 000 ₽): операция ждёт подтверждения, проводки нет, владельцу — карточка", async () => {
    const { service, ledger, notifier, audit } = harness();
    const draft = await service.create(FINANCE, expense("20000"));

    const held = await service.submit(FINANCE, draft.operationId);

    expect(held).toMatchObject({ status: "pending", entry: null, amountUsd: "250.00" });
    expect(ledger.postCalls).toBe(0);
    expect(notifier.pending).toHaveBeenCalledTimes(1);
    expect(notifier.pending).toHaveBeenCalledWith(expect.objectContaining({ operationId: draft.operationId, kind: "expense", summary: "20000 RUB", amountUsd: "250.00", authorId: FINANCE.accountId, note: "Оплата сервера" }));
    expect(audit.filter((entry) => entry.target === draft.operationId).map((entry) => entry.action)).toEqual(["ledger.operation.create", "ledger.operation.submit"]);
  });

  it("финансы, 40 $ (3 200 ₽): проводится сразу, карточки нет", async () => {
    const { service, ledger, notifier } = harness();
    const draft = await service.create(FINANCE, expense("3200"));

    const posted = await service.submit(FINANCE, draft.operationId);

    expect(posted).toMatchObject({ status: "posted" });
    expect(ledger.postCalls).toBe(1);
    expect(notifier.pending).not.toHaveBeenCalled();
  });

  it("владелец проводит крупное сразу: своих «на подтверждении» у него не бывает", async () => {
    const { service, ledger, notifier } = harness();
    const draft = await service.create(OWNER, expense("20000"));

    expect(await service.submit(OWNER, draft.operationId)).toMatchObject({ status: "posted" });
    expect(ledger.postCalls).toBe(1);
    expect(notifier.pending).not.toHaveBeenCalled();
  });

  it("нет курса — нет оценки — ждёт, даже сумма из одной копейки", async () => {
    const { service, fx, ledger } = harness();
    fx.rates = {};
    const draft = await service.create(FINANCE, expense("1"));
    expect(draft.amountUsd).toBeNull();

    expect(await service.submit(FINANCE, draft.operationId)).toMatchObject({ status: "pending" });
    expect(ledger.postCalls).toBe(0);
  });

  it("порог меняется в настройках без релиза: 100 $ — и 150 $ уже ждёт", async () => {
    const { service, threshold } = harness();
    const draft = await service.create(FINANCE, expense("12000"));

    threshold.value = 100;

    expect(await service.submit(FINANCE, draft.operationId)).toMatchObject({ status: "pending" });
  });

  it("исправление от финансов ждёт всегда; подтверждённое — сторно проведено", async () => {
    const { service, ledger } = harness();
    const original = await service.create(OWNER, expense("1000"));
    await service.submit(OWNER, original.operationId);

    const fix = await service.create(FINANCE, { kind: "reversal", note: "Ошибся суммой", at: AT, sourceKey: `op:${original.operationId}` });
    expect(await service.submit(FINANCE, fix.operationId)).toMatchObject({ status: "pending" });
    expect(ledger.entries.has(`op:${fix.operationId}`)).toBe(false);

    expect(await service.approve(OWNER, fix.operationId)).toMatchObject({ status: "posted", decidedBy: OWNER.accountId });
    expect(ledger.entries.has(`op:${fix.operationId}`)).toBe(true);
  });

  it("повторный submit ожидающей — та же операция, второй карточки нет; править и удалять её нельзя", async () => {
    const { service, notifier } = harness();
    const draft = await service.create(FINANCE, expense("20000"));
    await service.submit(FINANCE, draft.operationId);

    expect(await service.submit(FINANCE, draft.operationId)).toMatchObject({ status: "pending" });
    expect(notifier.pending).toHaveBeenCalledTimes(1);
    expect((await domainError(service.update(FINANCE, draft.operationId, expense("100")))).code).toBe("ledger_operation_not_draft");
    expect((await domainError(service.discard(FINANCE, draft.operationId))).code).toBe("ledger_operation_not_draft");
  });

  it("approve: проводка op:<id>, решение и время записаны, аудит, в чат — «подтверждено»", async () => {
    const { service, ledger, notifier, audit } = harness();
    const draft = await service.create(FINANCE, expense("20000"));
    await service.submit(FINANCE, draft.operationId);

    const posted = await service.approve(OWNER, draft.operationId, "Согласовано");

    expect(posted).toMatchObject({ status: "posted", decidedBy: OWNER.accountId, decisionNote: "Согласовано" });
    expect(posted.decidedAt).not.toBeNull();
    expect(ledger.entries.has(`op:${draft.operationId}`)).toBe(true);
    expect(ledger.postCalls).toBe(1);
    expect(audit.filter((entry) => entry.target === draft.operationId).map((entry) => entry.action)).toContain("ledger.operation.approve");
    expect(notifier.decided).toHaveBeenCalledWith(expect.objectContaining({ operationId: draft.operationId }), { approved: true, deciderId: OWNER.accountId, note: "Согласовано" });
  });

  it("approve без комментария — тоже можно: комментарий необязателен", async () => {
    const { service } = harness();
    const draft = await service.create(FINANCE, expense("20000"));
    await service.submit(FINANCE, draft.operationId);

    expect(await service.approve(OWNER, draft.operationId)).toMatchObject({ status: "posted", decisionNote: null });
  });

  it("reject: нужна причина; проводки нет; статус «отклонена», в чат — «отклонено: причина»", async () => {
    const { service, ledger, notifier, audit } = harness();
    const draft = await service.create(FINANCE, expense("20000"));
    await service.submit(FINANCE, draft.operationId);

    expect((await domainError(service.reject(OWNER, draft.operationId, "  "))).code).toBe("validation_failed");
    expect(await service.get(draft.operationId)).toMatchObject({ status: "pending" });

    const rejected = await service.reject(OWNER, draft.operationId, "Сумма не сходится с чеком");

    expect(rejected).toMatchObject({ status: "rejected", decidedBy: OWNER.accountId, decisionNote: "Сумма не сходится с чеком", entry: null });
    expect(ledger.postCalls).toBe(0);
    expect(audit.filter((entry) => entry.target === draft.operationId).map((entry) => entry.action)).toContain("ledger.operation.reject");
    expect(notifier.decided).toHaveBeenCalledWith(expect.objectContaining({ operationId: draft.operationId }), { approved: false, deciderId: OWNER.accountId, note: "Сумма не сходится с чеком" });
  });

  it("повторное решение — 409: подтверждённую не отклонить и не подтвердить второй раз, отклонённую не подтвердить", async () => {
    const { service, ledger } = harness();
    const first = await service.create(FINANCE, expense("20000"));
    await service.submit(FINANCE, first.operationId);
    await service.approve(OWNER, first.operationId);
    const second = await service.create(FINANCE, expense("30000"));
    await service.submit(FINANCE, second.operationId);
    await service.reject(OWNER, second.operationId, "Не согласовано");

    for (const call of [
      () => service.approve(OWNER, first.operationId),
      () => service.reject(OWNER, first.operationId, "Передумал"),
      () => service.approve(OWNER, second.operationId),
      () => service.reject(OWNER, second.operationId, "Ещё раз"),
    ]) {
      const error = await domainError(call());
      expect(error.code).toBe("ledger_operation_not_pending");
      expect(error.status).toBe(409);
    }
    expect(ledger.postCalls).toBe(1);
  });

  it("решать можно только то, что ждёт: черновик подтвердить нельзя", async () => {
    const { service } = harness();
    const draft = await service.create(FINANCE, expense("20000"));

    expect((await domainError(service.approve(OWNER, draft.operationId))).code).toBe("ledger_operation_not_pending");
    expect((await domainError(service.reject(OWNER, draft.operationId, "Нет"))).code).toBe("ledger_operation_not_pending");
  });

  it("подтвердить и отклонить может только тот, у кого есть право: финансы — 403, операция остаётся ждать", async () => {
    const { service, ledger } = harness();
    const draft = await service.create(FINANCE, expense("20000"));
    await service.submit(FINANCE, draft.operationId);

    expect((await domainError(service.approve(FINANCE, draft.operationId))).status).toBe(403);
    expect((await domainError(service.reject(FINANCE, draft.operationId, "Сам себе"))).status).toBe(403);
    expect(await service.get(draft.operationId)).toMatchObject({ status: "pending" });
    expect(ledger.postCalls).toBe(0);
  });

  it("неизвестная операция — 404", async () => {
    const { service } = harness();

    expect((await domainError(service.approve(OWNER, randomUUID()))).status).toBe(404);
    expect((await domainError(service.reject(OWNER, randomUUID(), "Нет такой"))).status).toBe(404);
  });

  it("сбой уведомления операцию не роняет: она всё равно ждёт, и проведение не страдает", async () => {
    const { service, notifier } = harness();
    notifier.pending.mockRejectedValue(new Error("Telegram недоступен"));
    notifier.decided.mockRejectedValue(new Error("Telegram недоступен"));
    const draft = await service.create(FINANCE, expense("20000"));

    expect(await service.submit(FINANCE, draft.operationId)).toMatchObject({ status: "pending" });
    expect(await service.approve(OWNER, draft.operationId)).toMatchObject({ status: "posted" });
  });
});

describe("OperationsService: картинка чека", () => {
  const RECEIPT = "a".repeat(64);

  it("в create и update — id картинки; проверка в хранилище: есть и профиль finance_receipt", async () => {
    const { service, media } = harness();

    const draft = await service.create(FINANCE, expense("1000", { receiptImage: RECEIPT }));

    expect(media.require).toHaveBeenCalledWith(RECEIPT, "finance_receipt");
    expect(draft.input).toMatchObject({ receiptImage: RECEIPT });
    const updated = await service.update(FINANCE, draft.operationId, expense("1200", { receiptImage: "b".repeat(64) }));
    expect(media.require).toHaveBeenLastCalledWith("b".repeat(64), "finance_receipt");
    expect(updated.input).toMatchObject({ receiptImage: "b".repeat(64) });
  });

  it("чужая картинка (не того профиля или нет в хранилище) — отказ, черновика нет", async () => {
    const { service, media, repository } = harness();
    media.require.mockRejectedValue(new DomainError("image_rejected", "Это не снимок чека", 400));

    expect((await domainError(service.create(FINANCE, expense("1000", { receiptImage: RECEIPT })))).code).toBe("image_rejected");
    expect(repository.rows.size).toBe(0);
  });

  it("без картинки хранилище не спрашивают; id не из 64 hex — отказ схемы", async () => {
    const { service, media } = harness();

    await service.create(FINANCE, expense("1000"));
    expect(media.require).not.toHaveBeenCalled();
    expect((await domainError(service.create(FINANCE, expense("1000", { receiptImage: "не-хэш" })))).code).toBe("ledger_operation_invalid");
  });

  it("картинку можно убрать правкой: поле пропало — колонка пуста", async () => {
    const { service } = harness();
    const draft = await service.create(FINANCE, expense("1000", { receiptImage: RECEIPT }));

    const updated = await service.update(FINANCE, draft.operationId, expense("1000"));

    expect(updated.input).not.toHaveProperty("receiptImage");
  });
});

// ---- Уведомление ----

const CARD: OperationCard = { operationId: "6f1d3c52-5a0e-4a8e-9d57-0c6f0a2d9b11", kind: "expense", summary: "20000 RUB", amountUsd: "250.00", authorId: FINANCE.accountId, note: "Оплата сервера за ноябрь" };

describe("текст уведомления", () => {
  it("карточка: вид, сумма, валюта, оценка в долларах, имя автора, причина и где подтвердить", () => {
    const text = pendingText(CARD, "Ирина");

    expect(text).toContain("💼 Операция на подтверждении: расход 20000 RUB (≈ 250.00 $) — Ирина: «Оплата сервера за ноябрь»");
    expect(text).toContain(CARD.operationId);
    expect(text).toContain("Бухгалтерия");
  });

  it("без оценки — «≈ ? $» не пишем: сказано, что курса не было", () => {
    const text = pendingText({ ...CARD, amountUsd: null }, "Ирина");

    expect(text).toContain("(курса не было)");
    expect(text).not.toContain("≈");
  });

  it("исправление: вид «исправление», сумма — ключ исправляемой проводки", () => {
    const text = pendingText({ ...CARD, kind: "reversal", summary: "проводки «purchase:1:paid»", amountUsd: null }, "Ирина");

    expect(text).toContain("исправление проводки «purchase:1:paid»");
  });

  it("решение: «подтверждено» и «отклонено: причина», с названием операции и именем решившего", () => {
    expect(decidedText(CARD, "Ирина", { approved: true, deciderName: "Владелец", note: null })).toMatch(/подтверждено/i);
    const rejected = decidedText(CARD, "Ирина", { approved: false, deciderName: "Владелец", note: "Не сходится с чеком" });
    expect(rejected).toContain("отклонено: Не сходится с чеком");
    expect(rejected).toContain("расход 20000 RUB");
    expect(rejected).toContain("Владелец");
  });

  it("описание суммы по видам: перевод, обмен, расход, поступление, заём, исправление", () => {
    const chart = {
      places: new Map([
        ["bank.rub", { accountId: "bank.rub", name: "Банк", currency: "RUB", place: "bank.rub", archived: false, fee: { percentBp: null, fixed: null, fixedCurrency: null } }],
        ["wallet.usdt", { accountId: "wallet.usdt", name: "USDT", currency: "USDT", place: "wallet.usdt", archived: false, fee: { percentBp: null, fixed: null, fixedCurrency: null } }],
      ]),
      articles: new Map(),
    };
    const base = { note: "Причина операции", at: AT };

    expect(operationSummary({ kind: "transfer", ...base, from: "bank.rub", to: "bank.rub", amount: "1500" }, chart)).toBe("1500 RUB");
    expect(operationSummary({ kind: "exchange", ...base, from: "wallet.usdt", to: "bank.rub", given: "100", received: "9000" }, chart)).toBe("100 USDT → 9000 RUB");
    expect(operationSummary({ kind: "expense", ...base, from: "bank.rub", article: "vps", amount: "300.50" }, chart)).toBe("300.50 RUB");
    expect(operationSummary({ kind: "income", ...base, to: "wallet.usdt", article: "ads", amount: "75", forMonth: "2026-10" }, chart)).toBe("75 USDT");
    expect(operationSummary({ kind: "loan", ...base, to: "bank.rub", lender: "Иван", amount: "100000", premium: "0", repaymentBp: 1000 }, chart)).toBe("100000 RUB");
    expect(operationSummary({ kind: "reversal", ...base, sourceKey: "op:1" }, chart)).toBe("проводки «op:1»");
  });
});

describe("OperationsNotifier: поток «Бухгалтерия»", () => {
  function notifierWith(options: { finance?: string; general?: string | null; configured?: boolean; send?: () => Promise<{ status: string }> } = {}) {
    const sent: { target: { chatId: string; threadId: number | null }; text: string }[] = [];
    const send = options.send ?? (async () => ({ status: "sent" }));
    const messenger = {
      platform: "telegram",
      configured: true,
      ratePerSec: 20,
      send: async () => ({ status: "sent" }),
      sendToChat: async (target: { chatId: string; threadId: number | null }, text: string) => {
        sent.push({ target, text });
        return await send();
      },
    };
    const messengers = { for: () => (options.configured === false ? null : messenger) } as unknown as Messengers;
    const settings = { get: (setting: { key: string }) => (setting.key === "notify.chat.finance" ? (options.finance ?? "") : ""), onChange: () => undefined } as unknown as SettingsReader;
    const targets = { chats: () => ({ general: options.general === undefined ? { chatId: "-100500", threadId: null } : options.general === null ? null : { chatId: options.general, threadId: null } }) };
    const accounts = { displayNames: async (ids: readonly string[]) => new Map(ids.map((id) => [id, id === OWNER.accountId ? "Владелец" : "Ирина"])) };
    const notifier = new OperationsNotifier(settings, targets as never, messengers, accounts as never);
    return { notifier, sent };
  }

  it("карточка уходит в поток notify.chat.finance — чат и тема из настройки", async () => {
    const { notifier, sent } = notifierWith({ finance: "-1001234567890:57" });

    await notifier.pending(CARD);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.target).toEqual({ chatId: "-1001234567890", threadId: 57 });
    expect(sent[0]?.text).toContain("— Ирина: «Оплата сервера за ноябрь»");
  });

  it("поток не задан — общий чат; нет и его — тихо ничего, без ошибки", async () => {
    const withGeneral = notifierWith();
    await withGeneral.notifier.pending(CARD);
    expect(withGeneral.sent[0]?.target).toEqual({ chatId: "-100500", threadId: null });

    const nowhere = notifierWith({ general: null });
    await expect(nowhere.notifier.pending(CARD)).resolves.toBeUndefined();
    expect(nowhere.sent).toHaveLength(0);
  });

  it("решение — следующим сообщением в тот же поток: подтверждено или отклонено с причиной", async () => {
    const { notifier, sent } = notifierWith({ finance: "-1001234567890:57" });

    await notifier.decided(CARD, { approved: true, deciderId: OWNER.accountId, note: null });
    await notifier.decided(CARD, { approved: false, deciderId: OWNER.accountId, note: "Нет чека" });

    expect(sent.map((item) => item.target)).toEqual([
      { chatId: "-1001234567890", threadId: 57 },
      { chatId: "-1001234567890", threadId: 57 },
    ]);
    expect(sent[0]?.text).toMatch(/подтверждено/i);
    expect(sent[1]?.text).toContain("отклонено: Нет чека");
  });

  it("бот не настроен, Telegram отказал или бросил исключение — уведомление молчит и не бросает", async () => {
    await expect(notifierWith({ configured: false }).notifier.pending(CARD)).resolves.toBeUndefined();
    await expect(notifierWith({ send: async () => ({ status: "failed" }) }).notifier.pending(CARD)).resolves.toBeUndefined();
    await expect(
      notifierWith({
        send: async () => {
          throw new Error("сеть пропала");
        },
      }).notifier.pending(CARD),
    ).resolves.toBeUndefined();
  });
});
