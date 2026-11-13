import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import {
  compensatePayment,
  compensationPreviewSchema,
  discrepancyAction,
  fetchCompensationPreview,
  fetchPaymentJobs,
  fetchReconcileOverview,
  paymentJobsSchema,
  reconcileOverviewSchema,
  retryPaymentJob,
  runReconcile,
} from "../src/api/payments";
import { formatDateTime } from "../src/format";
import {
  PAYMENTS_TABS,
  compensationProblem,
  discrepancyButtons,
  discrepancyLabel,
  jobKindLabel,
  lastRunLine,
  resolutionLabel,
  tabOfRoute,
} from "../src/screens/payments/payments-tabs";
import { fakeFetch, json } from "./helpers";

// Вкладки «Расхождения» и «Брошенные задания» и окно компенсации (tasks/T-0438): чистые правила и разбор ответов серверов T-0431, T-0433, T-0435.

const PURCHASE_ID = "3f0c2a52-9d5b-4a79-8a41-0b2a1f6e8c11";
const DISCREPANCY_ID = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function discrepancy(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    discrepancyId: DISCREPANCY_ID,
    platform: "telegram",
    kind: "charged_unrecorded",
    chargeId: "x".repeat(131),
    purchaseId: null,
    accountId: null,
    displayName: null,
    payerId: "1234567",
    amount: 50,
    payload: null,
    occurredAt: "2026-11-11T09:00:00.000Z",
    detectedAt: "2026-11-12T03:00:00.000Z",
    resolution: null,
    resolvedAt: null,
    resolvedByName: null,
    note: null,
    ...over,
  };
}

describe("вкладки раздела «Платежи»", () => {
  it("порядок и названия", () => {
    expect(PAYMENTS_TABS.map((tab) => tab.id)).toEqual(["feed", "discrepancies", "jobs"]);
    expect(PAYMENTS_TABS.map((tab) => tab.title)).toEqual(["Лента", "Расхождения", "Брошенные задания"]);
  });

  it("вкладка по адресу: пусто и чужое — лента, номер покупки — карточка без вкладок", () => {
    expect(tabOfRoute(null)).toBe("feed");
    expect(tabOfRoute("discrepancies")).toBe("discrepancies");
    expect(tabOfRoute("jobs")).toBe("jobs");
    expect(tabOfRoute(PURCHASE_ID)).toBeNull();
    expect(tabOfRoute("abc")).toBe("feed");
  });
});

describe("подписи и кнопки расхождений", () => {
  it("кнопки по таблице видов", () => {
    expect(discrepancyButtons("charged_unrecorded")).toEqual(["retry", "refund", "dismiss"]);
    expect(discrepancyButtons("refund_unrecorded")).toEqual(["retry", "dismiss"]);
    expect(discrepancyButtons("recorded_missing")).toEqual(["dismiss"]);
  });

  it("подпись вида называет площадку возврата", () => {
    expect(discrepancyLabel("charged_unrecorded", "telegram")).toBe("Списано, но не записано");
    expect(discrepancyLabel("recorded_missing", "telegram")).toBe("Записано, но нет в выписке");
    expect(discrepancyLabel("refund_unrecorded", "telegram")).toBe("Возврат в Telegram, но не у нас");
    expect(discrepancyLabel("refund_unrecorded", "max")).toBe("Возврат в MAX, но не у нас");
    expect(discrepancyLabel("refund_unrecorded", "web")).toBe("Возврат в веб, но не у нас");
  });

  it("решения и виды заданий; незнакомое — как есть", () => {
    expect(resolutionLabel("matched")).toBe("сошлось само");
    expect(resolutionLabel("retried")).toBe("учёт повторён");
    expect(resolutionLabel("refunded")).toBe("звёзды возвращены");
    expect(resolutionLabel("dismissed")).toBe("разобрано");
    expect(resolutionLabel("новое")).toBe("новое");
    expect(jobKindLabel("confirm")).toBe("подтверждение оплаты");
    expect(jobKindLabel("refund")).toBe("возврат");
    expect(jobKindLabel("refunded")).toBe("внешний возврат");
    expect(jobKindLabel("unknown")).toBe("неизвестно");
    expect(jobKindLabel("что-то")).toBe("что-то");
  });
});

describe("проверка окна компенсации", () => {
  const note = "Сбой записи оплаты 11.11";

  it("сумма — целое число от 1 до потолка", () => {
    const text = "Сумма — целое число от 1 до 500 самоцветов";
    expect(compensationProblem(0, 500, note)).toBe(text);
    expect(compensationProblem(2.5, 500, note)).toBe(text);
    expect(compensationProblem(501, 500, note)).toBe(text);
    expect(compensationProblem(Number.NaN, 500, note)).toBe(text);
  });

  it("потолок склоняется по числу самоцветов", () => {
    expect(compensationProblem(0, 1, note)).toBe("Сумма — целое число от 1 до 1 самоцвета");
    expect(compensationProblem(0, 3, note)).toBe("Сумма — целое число от 1 до 3 самоцветов");
  });

  it("причина — 3–200 знаков, текст как у остальных действий с платежом", () => {
    expect(compensationProblem(500, 500, "ab")).toContain("Причина — от 3 символов");
    expect(compensationProblem(500, 500, "а".repeat(201))).toBe("Причина — до 200 символов");
  });

  it("всё верно — можно", () => {
    expect(compensationProblem(1, 500, note)).toBeNull();
    expect(compensationProblem(500, 500, note)).toBeNull();
  });
});

describe("строка последней сверки", () => {
  const run = { startedAt: "2026-11-12T03:00:00.000Z", finishedAt: "2026-11-12T03:01:00.000Z", scanned: 1, found: 0, error: null };

  it("удачная — склонения операций", () => {
    const when = formatDateTime(run.finishedAt);
    expect(lastRunLine(run)).toBe(`Последняя сверка: ${when} · прочитано 1 операцию · новых расхождений 0`);
    expect(lastRunLine({ ...run, scanned: 2, found: 3 })).toBe(`Последняя сверка: ${when} · прочитано 2 операции · новых расхождений 3`);
    expect(lastRunLine({ ...run, scanned: 5 })).toBe(`Последняя сверка: ${when} · прочитано 5 операций · новых расхождений 0`);
    expect(lastRunLine({ ...run, scanned: 21 })).toContain("прочитано 21 операцию");
    expect(lastRunLine({ ...run, scanned: 12 })).toContain("прочитано 12 операций");
  });

  it("оборванная — с текстом ошибки", () => {
    const when = formatDateTime(run.finishedAt);
    expect(lastRunLine({ ...run, error: "Telegram не ответил" })).toBe(`Последняя сверка оборвалась ${when}: Telegram не ответил`);
  });

  it("не закончена — дата начала; сверок нет — «ещё не было»", () => {
    expect(lastRunLine({ ...run, finishedAt: null })).toContain(formatDateTime(run.startedAt));
    expect(lastRunLine(null)).toBe("Сверок ещё не было");
  });
});

describe("разбор ответов сервера", () => {
  const overview = {
    enabled: true,
    lastRuns: [{ platform: "telegram", trigger: "schedule", startedAt: "2026-11-12T03:00:00.000Z", finishedAt: "2026-11-12T03:01:00.000Z", scanned: 10, found: 1, error: null }],
    open: [discrepancy(), discrepancy({ discrepancyId: "other", kind: "будущий_вид" }), discrepancy({ kind: "recorded_missing", purchaseId: PURCHASE_ID })],
    resolved: [discrepancy({ resolution: "dismissed", resolvedAt: "2026-11-12T10:00:00.000Z", resolvedByName: "Владелец", note: "разобрали" }), discrepancy({ resolution: "новое_решение" })],
  };

  it("незнакомый вид или решение — строка пропущена, остальные на месте", () => {
    const parsed = reconcileOverviewSchema.parse(overview);
    expect(parsed.open.map((row) => row.kind)).toEqual(["charged_unrecorded", "recorded_missing"]);
    expect(parsed.resolved).toHaveLength(1);
    expect(parsed.resolved[0]?.resolution).toBe("dismissed");
    expect(parsed.lastRuns).toHaveLength(1);
    expect(parsed.enabled).toBe(true);
  });

  it("лишние поля отброшены, пустые ссылки — null", () => {
    const parsed = reconcileOverviewSchema.parse({ ...overview, open: [discrepancy({ лишнее: 1 })], resolved: [] });
    expect(parsed.open[0]).not.toHaveProperty("лишнее");
    expect(parsed.open[0]?.purchaseId).toBeNull();
  });

  it("изменившийся тип поля — ошибка разбора", () => {
    expect(reconcileOverviewSchema.safeParse({ ...overview, enabled: "yes" }).success).toBe(false);
  });

  it("задания: доступность и строки", () => {
    const parsed = paymentJobsSchema.parse({
      available: true,
      jobs: [{ jobId: "confirm-abc", kind: "confirm", chargeId: "c1", purchaseId: null, payerId: null, amount: 50, reason: "value too long", attempts: 10, failedAt: "2026-11-11T09:02:00.000Z" }],
    });
    expect(parsed.jobs[0]?.reason).toBe("value too long");
    expect(paymentJobsSchema.parse({ available: false, jobs: [] }).jobs).toEqual([]);
  });

  it("предпросмотр компенсации: запись без начисления и ручные начисления", () => {
    const parsed = compensationPreviewSchema.parse({
      purchaseId: PURCHASE_ID,
      blockedReason: null,
      chargedStars: 50,
      equivalentGems: 150,
      multiplier: 2,
      suggestedGems: 300,
      maxGems: 500,
      existing: { gems: 300, suggested: 300, note: "Сбой записи", actorName: "Владелец", createdAt: "2026-11-12T10:00:00.000Z", credited: false },
      recentManual: [{ at: "2026-11-11T12:00:00.000Z", resource: "gems", amount: 100 }],
    });
    expect(parsed.existing?.credited).toBe(false);
    expect(parsed.recentManual[0]?.amount).toBe(100);
    expect(parsed.suggestedGems).toBe(300);
  });

  it("предпросмотр заблокированной покупки: суммы пусты", () => {
    const parsed = compensationPreviewSchema.parse({
      purchaseId: PURCHASE_ID,
      blockedReason: "Покупка не оплачена",
      chargedStars: 50,
      equivalentGems: null,
      multiplier: 2,
      suggestedGems: null,
      maxGems: 500,
      existing: null,
      recentManual: [],
    });
    expect(parsed.blockedReason).toBe("Покупка не оплачена");
    expect(parsed.suggestedGems).toBeNull();
  });
});

describe("вызовы сервера", () => {
  it("обзор сверки и «Сверить сейчас»", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { enabled: false, lastRuns: [], open: [], resolved: [] } }), json(200, { data: [{ platform: "telegram", scanned: 3, found: 1, matched: 0, open: 1, error: null }] }));
    const api = new AdminApi(fetch);
    expect((await fetchReconcileOverview(api)).ok).toBe(true);
    const run = await runReconcile(api);
    expect(calls[0]?.url).toBe("/api/v1/admin/payment-reconcile");
    expect(calls[1]?.url).toBe("/api/v1/admin/payment-reconcile/run");
    expect(calls[1]?.init.method).toBe("POST");
    expect(run.ok && run.data[0]?.found).toBe(1);
  });

  it("действие по расхождению: адрес и причина", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: discrepancy({ resolution: "refunded" }) }), json(200, { data: discrepancy({ resolution: "dismissed" }) }));
    const api = new AdminApi(fetch);
    expect((await discrepancyAction(api, DISCREPANCY_ID, "refund", "не записали")).ok).toBe(true);
    expect((await discrepancyAction(api, DISCREPANCY_ID, "dismiss", "разобрали")).ok).toBe(true);
    expect(calls[0]?.url).toBe(`/api/v1/admin/payment-reconcile/${DISCREPANCY_ID}/refund`);
    expect(calls[1]?.url).toBe(`/api/v1/admin/payment-reconcile/${DISCREPANCY_ID}/dismiss`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ note: "не записали" });
  });

  it("брошенные задания и повтор", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { available: true, jobs: [] } }), json(200, { data: { jobId: "confirm-abc", purchaseId: null } }));
    const api = new AdminApi(fetch);
    expect((await fetchPaymentJobs(api)).ok).toBe(true);
    expect((await retryPaymentJob(api, "confirm-abc", "починили")).ok).toBe(true);
    expect(calls[0]?.url).toBe("/api/v1/admin/payment-jobs");
    expect(calls[1]?.url).toBe("/api/v1/admin/payment-jobs/confirm-abc/retry");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ note: "починили" });
  });

  it("компенсация: предпросмотр и начисление", async () => {
    const { fetch, calls } = fakeFetch(
      json(200, { data: { purchaseId: PURCHASE_ID, blockedReason: null, chargedStars: 50, equivalentGems: 150, multiplier: 2, suggestedGems: 300, maxGems: 500, existing: null, recentManual: [] } }),
      json(200, { data: { purchaseId: PURCHASE_ID, gems: 300, balance: 1000, repaired: false } }),
    );
    const api = new AdminApi(fetch);
    expect((await fetchCompensationPreview(api, PURCHASE_ID)).ok).toBe(true);
    const done = await compensatePayment(api, PURCHASE_ID, { gems: 300, note: "Сбой записи оплаты 11.11" });
    expect(calls[0]?.url).toBe(`/api/v1/admin/payments/${PURCHASE_ID}/compensation`);
    expect(calls[1]?.url).toBe(`/api/v1/admin/payments/${PURCHASE_ID}/compensate`);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ gems: 300, note: "Сбой записи оплаты 11.11" });
    expect(done.ok && done.data.gems).toBe(300);
  });
});
