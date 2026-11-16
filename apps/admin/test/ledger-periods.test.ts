import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import {
  closePeriod,
  loadPayouts,
  loadPeriod,
  loadPeriods,
  payoutStatusSchema,
  periodReportSchema,
  reopenPeriod,
  sendPayout,
  startReview,
  type ParticipantStatus,
  type PayoutStatusView,
  type PeriodReportView,
  type ReportView,
} from "../src/api/ledger-periods";
import { ChecklistView } from "../src/screens/ledger/periods/ChecklistView";
import {
  closeConsequence,
  closeControl,
  confirmationLabel,
  formatRub,
  formatUsd,
  monthName,
  monthTitle,
  participantsTotalRub,
  payoutBody,
  payoutProblem,
  payoutTargets,
  reopenControl,
  reviewControl,
  type PayoutForm,
} from "../src/screens/ledger/periods/model";
import { ParticipantsView } from "../src/screens/ledger/periods/ParticipantsView";
import { PeriodActions } from "../src/screens/ledger/periods/PeriodActions";
import { ReportBody } from "../src/screens/ledger/periods/ReportBody";
import { fakeFetch, json } from "./helpers";

/**
 * «Бухгалтерия → Месяцы» (tasks/T-0470, Р222): отчёт по docs/11-revenue-split.md §5, кнопки закрытия и снятия закрытия
 * по состоянию и праву, выплата по правилам Р222, вызовы маршрутов. Суммы в панели не считаются — берутся из ответа
 * сервера как есть.
 */

const plain = (text: string) => text.replace(/[  ]/g, " ");
const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => plain(renderToStaticMarkup(node));

const ALINA = "11111111-1111-4111-8111-111111111111";
const BORIS = "22222222-2222-4222-8222-222222222222";
const VERA = "33333333-3333-4333-8333-333333333333";
const LOAN = "44444444-4444-4444-8444-444444444444";

function report(patch: Partial<ReportView> = {}): ReportView {
  return {
    currency: "USD",
    rubRate: "0.0125",
    revenue: [
      { key: "revenue.shop.telegram", name: "Магазин, Telegram", amount: "300.00" },
      { key: "revenue.vip.vk", name: "VIP, VK", amount: "90.00" },
    ],
    otherIncome: [{ key: "income.ads_adsgram.USD", name: "Реклама: AdsGram", amount: "246.54" }],
    expenses: [
      { key: "expense.vps", name: "Сервер (VPS)", amount: "40.00" },
      { key: "expense.fee_withdrawal", name: "Комиссия вывода", amount: "4.50" },
    ],
    grossRevenue: "636.54",
    totalExpenses: "44.50",
    profitBeforeTax: "592.04",
    tax: {
      rub: "2944.00",
      usd: "36.80",
      byPayer: [
        { payer: "individual", receiptsRub: "40000.00", ratePercent: "4.00", taxRub: "1600.00" },
        { payer: "legal", receiptsRub: "22400.00", ratePercent: "6.00", taxRub: "1344.00" },
      ],
    },
    netProfit: "555.24",
    tranches: [{ loanId: LOAN, lender: "Иван", usd: "100.00", inLoanCurrency: "100.00", currency: "USD", remainingAfterUsd: "400.00" }],
    toDistribute: "455.24",
    payouts: [
      { accountId: ALINA, name: "Алина", percent: "30.00", usd: "136.57", rub: "10925.60" },
      { accountId: BORIS, name: "Борис", percent: "20.00", usd: "91.05", rub: "7284.00" },
    ],
    ownerAmount: "227.62",
    noDistribution: false,
    ...patch,
  };
}

function view(patch: Partial<PeriodReportView> = {}): PeriodReportView {
  return {
    period: "2026-11",
    status: "review",
    reopenedCount: 0,
    reviewAt: "2026-12-02T09:00:00.000Z",
    closedAt: null,
    checklist: [],
    canClose: true,
    reportIsDraft: true,
    report: report(),
    ...patch,
  };
}

const BLOCKER = { code: "operations_pending" as const, severity: "blocker" as const, count: 1, message: "1 операция ждёт подтверждения", refs: [{ kind: "operation" as const, id: "op-1" }], moreRefs: 0 };
const WARNING = { code: "receipts_missing" as const, severity: "warning" as const, count: 2, message: "2 рублёвых поступления без чека", refs: [{ kind: "entry" as const, id: "en-1" }], moreRefs: 0 };

function participant(patch: Partial<ParticipantStatus> & Pick<ParticipantStatus, "accountId" | "name">): ParticipantStatus {
  return {
    owedRub: "10925.60",
    paidRub: "0.00",
    remainingRub: "10925.60",
    confirmation: null,
    gate: { state: "wait", reason: "Участник ещё не подтвердил отчёт: срок на подтверждение до 2026-12-07 09:00 UTC", until: "2026-12-07T09:00:00.000Z" },
    canPay: false,
    needsReason: false,
    reason: "Участник ещё не подтвердил отчёт: срок на подтверждение до 2026-12-07 09:00 UTC",
    ...patch,
  };
}

const CONFIRMED = participant({
  accountId: ALINA,
  name: "Алина",
  confirmation: { status: "confirmed", comment: null, decidedAt: "2026-12-03T10:00:00.000Z" },
  gate: { state: "free" },
  canPay: true,
  reason: null,
});
const DISPUTED = participant({
  accountId: BORIS,
  name: "Борис",
  owedRub: "7284.00",
  remainingRub: "7284.00",
  confirmation: { status: "disputed", comment: "Не сходится реклама", decidedAt: "2026-12-04T10:00:00.000Z" },
  gate: { state: "override", reason: "Участник оспорил отчёт («Не сходится реклама»): платить можно только по решению владельца с причиной" },
  canPay: true,
  needsReason: true,
  reason: "Участник оспорил отчёт («Не сходится реклама»): платить можно только по решению владельца с причиной",
});
const SILENT = participant({ accountId: VERA, name: "Вера", owedRub: "500.00", remainingRub: "500.00" });

function status(patch: Partial<PayoutStatusView> = {}): PayoutStatusView {
  return {
    period: "2026-11",
    closedAt: "2026-12-02T12:00:00.000Z",
    confirmDays: 5,
    confirmDeadlineAt: "2026-12-07T12:00:00.000Z",
    participants: [CONFIRMED, DISPUTED, SILENT],
    tax: { owedRub: "2944.00", paidRub: "0.00", remainingRub: "2944.00" },
    loans: [{ loanId: LOAN, lender: "Иван", currency: "USD", owed: "100.00", paid: "0.00", remaining: "100.00" }],
    owner: { shareUsd: "227.62" },
    payouts: [],
    ...patch,
  };
}

describe("формат денег и месяцев", () => {
  it("месяц словами; рубли и доллары из строки сервера без плавающей точки", () => {
    expect(monthTitle("2026-11")).toBe("Ноябрь 2026");
    expect(monthName("2026-03")).toBe("Март");
    expect(formatRub("2944.00")).toBe("2 944 ₽");
    expect(formatRub("10925.60")).toBe("10 925,60 ₽");
    expect(formatRub("0.00")).toBe("0 ₽");
    expect(formatUsd("246.54")).toBe("$246.54");
    expect(formatUsd("1234567.00")).toBe("$1 234 567.00");
  });
});

describe("отчёт месяца по docs/11 §5", () => {
  const text = html(createElement(ReportBody, { report: report(), isDraft: true }));

  it("все шесть разделов: платежи, реклама, расходы, налог, заём, прибыль к разделу и доли", () => {
    for (const heading of ["Доход с платежей", "Доход с рекламы и прочие поступления", "Операционные расходы", "Налог", "Заём", "К разделу и доли"]) {
      expect(text).toContain(heading);
    }
  });

  it("строки и суммы — как у сервера, в долларах и рублях", () => {
    expect(text).toContain("Магазин, Telegram");
    expect(text).toContain("$300.00");
    expect(text).toContain("Комиссия вывода");
    expect(text).toContain("2 944 ₽");
    expect(text).toContain("$36.80");
    expect(text).toContain("Алина");
    expect(text).toContain("10 925,60 ₽");
    expect(text).toContain("$227.62");
  });

  it("налог — с режимом и ставками по плательщикам", () => {
    expect(text).toContain("НПД");
    expect(text).toContain("физлица 4 %");
    expect(text).toContain("юрлица 6 %");
  });

  it("заём: транш и остаток после него", () => {
    expect(text).toContain("Иван");
    expect(text).toContain("$100.00");
    expect(text).toContain("$400.00");
  });

  it("без займа раздел остаётся с пометкой, что траншей нет; без дележа — пометка", () => {
    const empty = html(createElement(ReportBody, { report: report({ tranches: [], noDistribution: true, payouts: [] }), isDraft: false }));
    expect(empty).toContain("Заём");
    expect(empty).toContain("Траншей в этом месяце нет");
    expect(empty).toContain("Делить нечего");
  });

  it("черновик подписан, снимок закрытия — нет", () => {
    expect(text).toContain("Черновик");
    expect(html(createElement(ReportBody, { report: report(), isDraft: false }))).not.toContain("Черновик");
  });
});

describe("чек-лист сверки", () => {
  it("блокеры и предупреждения разными блоками, ссылки ведут к причине", () => {
    const text = html(createElement(ChecklistView, { items: [BLOCKER, WARNING] }));

    expect(text).toContain("Мешает закрыть");
    expect(text).toContain("1 операция ждёт подтверждения");
    expect(text).toContain("Предупреждения");
    expect(text).toContain("2 рублёвых поступления без чека");
    expect(text).toContain('href="#/ledger/operations"');
    expect(text).toContain('href="#/ledger/journal"');
  });

  it("пусто — «Блокеров нет»", () => {
    expect(html(createElement(ChecklistView, { items: [] }))).toContain("Блокеров нет");
  });
});

describe("закрытие месяца", () => {
  it("строка последствий: налог и сумма участникам — из отчёта сервера", () => {
    expect(participantsTotalRub(report())).toBe("18209.60");
    expect(closeConsequence("2026-11", report())).toBe("Ноябрь закроется: налог 2 944 ₽, участникам — 18 209,60 ₽ на всех. Участникам придёт сообщение.");
  });

  it("делить нечего — в строке нет суммы участникам", () => {
    expect(closeConsequence("2026-11", report({ noDistribution: true, payouts: [] }))).toBe("Ноябрь закроется: налог 2 944 ₽, делить нечего. Участникам придёт сообщение.");
  });

  it("кнопка неактивна, пока есть блокеры, и называет причину; без права её нет", () => {
    expect(closeControl({ view: view({ checklist: [BLOCKER], canClose: false }), allowed: true })).toEqual({ visible: true, disabled: true, blockedBy: "Есть блокеры: 1" });
    expect(closeControl({ view: view(), allowed: true })).toEqual({ visible: true, disabled: false, blockedBy: null });
    expect(closeControl({ view: view(), allowed: false }).visible).toBe(false);
    expect(closeControl({ view: view({ status: "open", canClose: false }), allowed: true }).visible).toBe(false);
    expect(closeControl({ view: view({ status: "closed", canClose: false }), allowed: true }).visible).toBe(false);
  });

  it("отчёт не посчитан (нет курса) — закрыть нельзя, даже если блокеров в списке нет", () => {
    const control = closeControl({ view: view({ report: null, canClose: false }), allowed: true });
    expect(control.disabled).toBe(true);
    expect(control.blockedBy).toContain("не посчитан");
  });

  it("«Закрыть месяц» в разметке: disabled при блокерах, активна без них", () => {
    const render = (patch: Partial<PeriodReportView>, allowed = true) =>
      html(createElement(PeriodActions, { view: view(patch), payouts: null, now: new Date("2026-12-02T10:00:00Z"), canClose: allowed, onReview: () => undefined, onClose: () => undefined, onReopen: () => undefined }));

    expect(render({ checklist: [BLOCKER], canClose: false })).toMatch(/<button[^>]*disabled[^>]*>Закрыть месяц</);
    expect(render({})).not.toMatch(/<button[^>]*disabled[^>]*>Закрыть месяц</);
    expect(render({})).toContain("Закрыть месяц");
    expect(render({}, false)).not.toContain("Закрыть месяц");
  });
});

describe("сверка: «Начать сверку»", () => {
  const now = new Date("2026-12-02T10:00:00Z");

  it("у кончившегося открытого месяца и при праве", () => {
    expect(reviewControl({ period: "2026-11", status: "open", now, allowed: true })).toBe(true);
    expect(reviewControl({ period: "2026-12", status: "open", now, allowed: true })).toBe(false);
    expect(reviewControl({ period: "2026-11", status: "review", now, allowed: true })).toBe(false);
    expect(reviewControl({ period: "2026-11", status: "open", now, allowed: false })).toBe(false);
  });
});

describe("снятие закрытия", () => {
  it("видно у закрытого месяца без выплат; после первой выплаты и без права — скрыто", () => {
    expect(reopenControl({ status: "closed", payoutsCount: 0, allowed: true })).toBe(true);
    expect(reopenControl({ status: "closed", payoutsCount: 1, allowed: true })).toBe(false);
    expect(reopenControl({ status: "closed", payoutsCount: 0, allowed: false })).toBe(false);
    expect(reopenControl({ status: "review", payoutsCount: 0, allowed: true })).toBe(false);
  });

  it("в разметке: кнопка есть, пока выплат нет, и пропадает после первой", () => {
    const render = (payouts: PayoutStatusView, allowed = true) =>
      html(createElement(PeriodActions, { view: view({ status: "closed", canClose: false, reportIsDraft: false }), payouts, now: new Date("2026-12-03T10:00:00Z"), canClose: allowed, onReview: () => undefined, onClose: () => undefined, onReopen: () => undefined }));
    const paid = status({ payouts: [{ operationId: "op", payee: `stakeholder:${ALINA}`, currency: "RUB", amount: "100.00", overrideReason: null, at: "2026-12-03T09:00:00.000Z" }] });

    expect(render(status())).toContain("Снять закрытие");
    expect(render(paid)).not.toContain("Снять закрытие");
    expect(render(status(), false)).not.toContain("Снять закрытие");
  });
});

describe("участники закрытого месяца", () => {
  const render = (patch: { status?: PayoutStatusView; canPay?: boolean } = {}) =>
    html(createElement(ParticipantsView, { status: patch.status ?? status(), canPay: patch.canPay ?? true, now: new Date("2026-12-05T12:00:00Z"), onPay: () => undefined }));

  it("состояния: подтвердил, оспорил с комментарием, молчит N дней", () => {
    const closedAt = new Date("2026-12-02T12:00:00Z");
    const now = new Date("2026-12-05T12:00:00Z");
    expect(confirmationLabel(CONFIRMED, closedAt, now)).toBe("подтвердил");
    expect(confirmationLabel(DISPUTED, closedAt, now)).toBe("оспорил (Не сходится реклама)");
    expect(confirmationLabel(SILENT, closedAt, now)).toBe("молчит 3 дн.");
    expect(confirmationLabel(SILENT, closedAt, closedAt)).toBe("молчит 0 дн.");
  });

  it("долг, выплачено и остаток — строками сервера", () => {
    const text = render();
    expect(text).toContain("10 925,60 ₽");
    expect(text).toContain("7 284 ₽");
    expect(text).toContain("подтвердил");
    expect(text).toContain("оспорил (Не сходится реклама)");
    expect(text).toContain("молчит 3 дн.");
  });

  it("«Выплатить» — у подтвердившего и у оспорившего; у молчащего до срока — нет, причина названа", () => {
    const text = render();
    expect(text.match(/>Выплатить</g)?.length).toBe(2);
    expect(text).toContain("Участник ещё не подтвердил отчёт: срок на подтверждение до 2026-12-07 09:00 UTC");
  });

  it("без права вносить операции кнопок выплат нет", () => {
    expect(render({ canPay: false })).not.toContain(">Выплатить<");
  });

  it("владелец, налог и заём — свои строки с формами выплаты; налога или займа нет — строк нет", () => {
    const text = render();
    expect(text).toContain("Выплатить себе");
    expect(text).toContain("Заплатить налог");
    expect(text).toContain("Иван");
    const bare = render({ status: status({ tax: null, loans: [], owner: null }) });
    expect(bare).not.toContain("Выплатить себе");
    expect(bare).not.toContain("Заплатить налог");
  });

  it("выплаты месяца перечислены с причиной решения владельца", () => {
    const text = render({
      status: status({ payouts: [{ operationId: "op", payee: `stakeholder:${BORIS}`, currency: "RUB", amount: "7284.00", overrideReason: "Спор закрыт по телефону", at: "2026-12-04T09:00:00.000Z" }] }),
    });
    expect(text).toContain("Спор закрыт по телефону");
  });
});

describe("форма выплаты", () => {
  const places = [
    { accountId: "bank.rub", name: "Банк, ₽", currency: "RUB" },
    { accountId: "bank.tbank", name: "Карта Т-Банка", currency: "RUB" },
    { accountId: "wallet.usdt", name: "Кошелёк USDT", currency: "USDT" },
    { accountId: "bank.usd", name: "Банк, $", currency: "USD" },
  ];
  const form = (patch: Partial<PayoutForm> = {}): PayoutForm => ({ payee: `stakeholder:${ALINA}`, from: "bank.rub", amount: "10925.60", reason: "", note: "Выплата за ноябрь: Алина", at: "2026-12-03", ...patch });

  it("цели: у участника сумма по умолчанию — остаток долга сервера, валюта рубли; причина нужна при споре и молчании", () => {
    const targets = payoutTargets(status());
    const alina = targets.find((target) => target.payee === `stakeholder:${ALINA}`);
    const boris = targets.find((target) => target.payee === `stakeholder:${BORIS}`);

    expect(alina).toMatchObject({ amount: "10925.60", currency: "RUB", needsReason: false });
    expect(boris).toMatchObject({ amount: "7284.00", currency: "RUB", needsReason: true });
    expect(targets.some((target) => target.payee === `stakeholder:${VERA}`)).toBe(false);
    expect(targets.find((target) => target.payee === "tax")).toMatchObject({ amount: "2944.00", currency: "RUB", needsReason: false });
    expect(targets.find((target) => target.payee === `loan:${LOAN}`)).toMatchObject({ amount: "100.00", currency: "USD" });
    expect(targets.find((target) => target.payee === "owner")).toMatchObject({ amount: "", currency: null, needsReason: false });
  });

  it("без подтверждения: пустая или короткая причина — проблема, три знака — можно", () => {
    const target = payoutTargets(status()).find((item) => item.payee === `stakeholder:${BORIS}`);
    if (target === undefined) throw new Error("нет цели");
    const base = form({ payee: target.payee });

    expect(payoutProblem(base, target, places)).toContain("причин");
    expect(payoutProblem({ ...base, reason: "ок" }, target, places)).toContain("причин");
    expect(payoutProblem({ ...base, reason: "Спор закрыт" }, target, places)).toBeNull();
  });

  it("подтверждённому причина не нужна; место другой валюты, нулевая и дробная сумма — проблемы", () => {
    const target = payoutTargets(status()).find((item) => item.payee === `stakeholder:${ALINA}`);
    if (target === undefined) throw new Error("нет цели");

    expect(payoutProblem(form(), target, places)).toBeNull();
    expect(payoutProblem(form({ from: "wallet.usdt" }), target, places)).toContain("рублях");
    expect(payoutProblem(form({ from: "" }), target, places)).toContain("Выберите место");
    expect(payoutProblem(form({ amount: "0" }), target, places)).toContain("больше нуля");
    expect(payoutProblem(form({ amount: "1.234" }), target, places)).toContain("знаков");
    expect(payoutProblem(form({ amount: "" }), target, places)).toContain("Укажите сумму");
    expect(payoutProblem(form({ note: "ab" }), target, places)).toContain("Описание");
  });

  it("владельцу — любое место, сумма вводится вручную", () => {
    const target = payoutTargets(status()).find((item) => item.payee === "owner");
    if (target === undefined) throw new Error("нет цели");

    expect(payoutProblem(form({ payee: "owner", from: "wallet.usdt", amount: "100.5" }), target, places)).toBeNull();
    expect(payoutProblem(form({ payee: "owner", from: "wallet.usdt", amount: "" }), target, places)).toContain("Укажите сумму");
  });

  it("тело операции: вид payout, получатель, месяц, место, сумма; причина — только если она введена", () => {
    expect(payoutBody("2026-11", form())).toEqual({
      kind: "payout",
      payee: `stakeholder:${ALINA}`,
      period: "2026-11",
      from: "bank.rub",
      amount: "10925.60",
      note: "Выплата за ноябрь: Алина",
      at: "2026-12-03",
    });
    expect(payoutBody("2026-11", form({ reason: "  Спор закрыт  " })).overrideReason).toBe("Спор закрыт");
    expect(payoutBody("2026-11", form({ amount: "10925,60" })).amount).toBe("10925.60");
  });
});

describe("вызовы маршрутов месяцев", () => {
  it("список и месяц читаются схемой", async () => {
    const { fetch, calls } = fakeFetch(
      json(200, { data: { periods: [{ period: "2026-12", status: "open", reopenedCount: 0, reviewAt: null, closedAt: null }] } }),
      json(200, { data: { period: view() } }),
    );
    const api = new AdminApi(fetch);

    const list = await loadPeriods(api);
    const month = await loadPeriod(api, "2026-11");

    expect(list.ok && list.data[0]?.period).toBe("2026-12");
    expect(month.ok && month.data.report?.toDistribute).toBe("455.24");
    expect(calls.map((call) => call.url)).toEqual(["/api/v1/admin/ledger/periods", "/api/v1/admin/ledger/periods/2026-11"]);
  });

  it("выплаты месяца: схема принимает ответ сервера", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { status: status() } }));

    const result = await loadPayouts(new AdminApi(fetch), "2026-11");

    expect(calls[0]?.url).toBe("/api/v1/admin/ledger/periods/2026-11/payouts");
    expect(result.ok && result.data.participants.length).toBe(3);
    expect(payoutStatusSchema.safeParse(status()).success).toBe(true);
    expect(periodReportSchema.safeParse(view()).success).toBe(true);
  });

  it("сверка, закрытие и снятие — POST; у снятия в теле причина", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { ok: true } }), json(200, { data: { ok: true } }), json(200, { data: { ok: true } }));
    const api = new AdminApi(fetch);

    await startReview(api, "2026-11");
    await closePeriod(api, "2026-11");
    await reopenPeriod(api, "2026-11", "  Ошибка в расходах  ");

    expect(calls.map((call) => `${call.init.method} ${call.url.replace("/api/v1/admin/ledger/periods/", "")}`)).toEqual(["POST 2026-11/review", "POST 2026-11/close", "POST 2026-11/reopen"]);
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ reason: "Ошибка в расходах" });
  });

  it("выплата: операция создаётся и сразу проводится; ответ — номер и статус", async () => {
    const id = "6f1d3c52-5a0e-4a8e-9d57-0c6f0a2d9b11";
    const { fetch, calls } = fakeFetch(json(200, { data: { operation: { operationId: id, status: "draft" } } }), json(200, { data: { operation: { operationId: id, status: "pending" } } }));

    const result = await sendPayout(new AdminApi(fetch), payoutBody("2026-11", { payee: "tax", from: "bank.rub", amount: "2944", reason: "", note: "Налог НПД за ноябрь", at: "2026-12-03" }));

    expect(calls[0]?.url).toBe("/api/v1/admin/ledger/operations");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ kind: "payout", payee: "tax", period: "2026-11" });
    expect(calls[1]?.url).toBe(`/api/v1/admin/ledger/operations/${id}/submit`);
    expect(result).toEqual({ ok: true, data: { operationId: id, status: "pending" } });
  });

  it("отказ при проведении: черновик убирается, ошибка — текстом сервера", async () => {
    const id = "6f1d3c52-5a0e-4a8e-9d57-0c6f0a2d9b11";
    const { fetch, calls } = fakeFetch(
      json(200, { data: { operation: { operationId: id, status: "draft" } } }),
      json(400, { error: { code: "ledger_operation_invalid", message: "Участник ещё не подтвердил отчёт: срок на подтверждение до 2026-12-07 09:00 UTC" } }),
      json(200, { data: { ok: true } }),
    );

    const result = await sendPayout(new AdminApi(fetch), payoutBody("2026-11", { payee: `stakeholder:${VERA}`, from: "bank.rub", amount: "500", reason: "", note: "Выплата Вере", at: "2026-12-03" }));

    expect(!result.ok && result.error.message).toBe("Участник ещё не подтвердил отчёт: срок на подтверждение до 2026-12-07 09:00 UTC");
    expect(calls[2]?.url).toBe(`/api/v1/admin/ledger/operations/${id}/discard`);
  });

  it("ошибки 409 при закрытии приходят текстом сервера", async () => {
    const { fetch } = fakeFetch(json(409, { error: { code: "ledger_period_blocked", message: "Месяц 2026-11 закрыть нельзя: 1 операция ждёт подтверждения" } }));

    const result = await closePeriod(new AdminApi(fetch), "2026-11");

    expect(!result.ok && result.error.message).toBe("Месяц 2026-11 закрыть нельзя: 1 операция ждёт подтверждения");
  });
});
