import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminApi, type ApiError } from "../src/api/client";
import { decideMyReport, disputeProblem, loadMyReport, myReportSchema, reportStatus, type MyReport, type MyProject } from "../src/api/my-project";
import { ClosedMonth } from "../src/screens/my-project/ClosedMonth";
import { MyProjectContent } from "../src/screens/my-project/MyProjectScreen";

/**
 * «Мой проект»: отчёт закрытого месяца и решение участника (tasks/T-0471, Р222). Ответ сервера (T-0469) разбирается
 * схемой, отчёт показывает все разделы docs/11 §5, статус — одного из четырёх видов, спор без комментария не уходит.
 */

const REPORT: MyReport = {
  period: "2026-10",
  closedAt: "2026-11-02T09:00:00.000Z",
  deadlineAt: "2026-11-09T09:00:00.000Z",
  report: {
    currency: "USD",
    rubRate: "0.0108",
    revenue: [
      { key: "revenue:telegram", name: "Telegram: Stars", amount: "900.00" },
      { key: "revenue:vk", name: "VK: голоса", amount: "100.00" },
    ],
    otherIncome: [{ key: "income:ads", name: "Реклама: показы", amount: "50.00" }],
    expenses: [
      { key: "expense:servers", name: "Серверы", amount: "120.00" },
      { key: "expense:ads", name: "Закупка трафика", amount: "230.00" },
    ],
    grossRevenue: "1050.00",
    totalExpenses: "350.00",
    profitBeforeTax: "700.00",
    tax: {
      rub: "5400.00",
      usd: "58.32",
      byPayer: [
        { payer: "individual", receiptsRub: "60000.00", ratePercent: "6.00", taxRub: "3600.00" },
        { payer: "legal", receiptsRub: "36000.00", ratePercent: "5.00", taxRub: "1800.00" },
      ],
    },
    netProfit: "641.68",
    tranches: [{ loanId: "loan-1", lender: "Займодавец А", usd: "100.00", inLoanCurrency: "9250.00", currency: "RUB", remainingAfterUsd: "400.00" }],
    toDistribute: "541.68",
    payouts: [
      { accountId: "acc-me", name: "Анна", percent: "25.00", usd: "135.42", rub: "15980.40" },
      { accountId: "acc-bob", name: "Борис", percent: "5.00", usd: "27.08", rub: "3196.08" },
    ],
    ownerAmount: "379.18",
    noDistribution: false,
  },
  mine: {
    accountId: "acc-me",
    name: "Анна",
    owedRub: "15980.40",
    paidRub: "0.00",
    remainingRub: "15980.40",
    confirmation: null,
    canChange: true,
  },
};

const withMine = (patch: Partial<MyReport["mine"]>): MyReport => ({ ...REPORT, mine: { ...REPORT.mine, ...patch } });
const DECIDED_AT = "2026-11-03T10:00:00.000Z";
const CONFIRMED = withMine({ confirmation: { status: "confirmed", comment: null, decidedAt: DECIDED_AT } });
const DISPUTED = withMine({ confirmation: { status: "disputed", comment: "Не сходятся расходы на серверы", decidedAt: DECIDED_AT } });
const PAID = withMine({ confirmation: { status: "confirmed", comment: null, decidedAt: DECIDED_AT }, paidRub: "15980.40", remainingRub: "0.00", canChange: false });

const plain = (text: string) => text.replace(/\s/g, " ");
const html = (report: MyReport, props: { error?: ApiError | null; initialDisputing?: boolean } = {}) =>
  plain(renderToStaticMarkup(createElement(ClosedMonth, { report, busy: false, error: props.error ?? null, initialDisputing: props.initialDisputing ?? false, onDecide: () => undefined })));

describe("ответ сервера", () => {
  it("разбирается схемой", () => {
    expect(myReportSchema.parse(REPORT).mine.owedRub).toBe("15980.40");
    expect(myReportSchema.parse(CONFIRMED).mine.confirmation?.status).toBe("confirmed");
  });

  it("мусор отклоняется", () => {
    expect(myReportSchema.safeParse({ period: "2026-10" }).success).toBe(false);
    expect(myReportSchema.safeParse({ ...REPORT, mine: { ...REPORT.mine, canChange: "да" } }).success).toBe(false);
  });

  it("статус — по решению и выплате", () => {
    expect(reportStatus(REPORT)).toBe("waiting");
    expect(reportStatus(CONFIRMED)).toBe("confirmed");
    expect(reportStatus(DISPUTED)).toBe("disputed");
    expect(reportStatus(PAID)).toBe("paid");
  });
});

describe("отчёт закрытого месяца", () => {
  it("моя часть — крупно в рублях и рядом в долларах", () => {
    const text = html(REPORT);
    expect(text).toContain("15 980,40 ₽");
    expect(text).toContain("135,42 $");
    expect(text.indexOf("Моя часть")).toBeLessThan(text.indexOf("15 980,40 ₽"));
  });

  it("все разделы docs/11 §5", () => {
    const text = html(REPORT);
    // доходы по площадкам
    expect(text).toContain("Telegram: Stars");
    expect(text).toContain("VK: голоса");
    expect(text).toContain("Реклама: показы");
    expect(text).toContain("1 050,00 $");
    // расходы построчно
    expect(text).toContain("Серверы");
    expect(text).toContain("Закупка трафика");
    expect(text).toContain("350,00 $");
    expect(text).toContain("700,00 $");
    // налог с режимом и ставками
    expect(text).toContain("Налог");
    expect(text).toContain("Физические лица");
    expect(text).toContain("Юридические лица");
    expect(text).toContain("6,00 %");
    expect(text).toContain("5,00 %");
    expect(text).toContain("5 400,00 ₽");
    expect(text).toContain("58,32 $");
    expect(text).toContain("641,68 $");
    // займ: транш и остаток
    expect(text).toContain("Займодавец А");
    expect(text).toContain("9 250,00 RUB");
    expect(text).toContain("400,00 $");
    // к разделу, все участники и остаток владельца
    expect(text).toContain("541,68 $");
    expect(text).toContain("Анна");
    expect(text).toContain("Борис");
    expect(text).toContain("25,00 %");
    expect(text).toContain("5,00 %");
    expect(text).toContain("3 196,08 ₽");
    expect(text).toContain("Остаток владельца");
    expect(text).toContain("379,18 $");
  });

  it("свою строку в участниках отмечает «вы»", () => {
    expect(html(REPORT)).toContain("Анна · вы");
    expect(html(REPORT)).not.toContain("Борис · вы");
  });

  it("без займа и налога разделы не рисуются пустыми", () => {
    const bare: MyReport = { ...REPORT, report: { ...REPORT.report, tranches: [], tax: { rub: "0.00", usd: "0.00", byPayer: [] } } };
    const text = html(bare);
    expect(text).not.toContain("Займ");
    expect(text).not.toContain("Физические лица");
  });

  it("месяц без раздела: «делить было нечего»", () => {
    const text = html({ ...REPORT, report: { ...REPORT.report, noDistribution: true, toDistribute: "0.00", payouts: [] } });
    expect(text).toContain("Делить в этом месяце было нечего");
  });
});

describe("статусы", () => {
  it("ждёт подтверждения", () => {
    const text = html(REPORT);
    expect(text).toContain("Ждёт твоего подтверждения");
    expect(text).not.toContain("Черновик");
  });

  it("подтвердил", () => {
    expect(html(CONFIRMED)).toContain("Ты подтвердил");
  });

  it("оспорил — с комментарием", () => {
    expect(html(DISPUTED)).toContain("Ты оспорил: Не сходятся расходы на серверы");
  });

  it("выплачено — суммой", () => {
    expect(html(PAID)).toContain("Выплачено 15 980,40 ₽");
  });

  it("частично выплачено: показан остаток", () => {
    const text = html(withMine({ paidRub: "5000.00", remainingRub: "10980.40", canChange: false }));
    expect(text).toContain("Выплачено 5 000,00 ₽");
    expect(text).toContain("осталось 10 980,40 ₽");
  });
});

describe("решение", () => {
  it("до решения — «Подтверждаю» и «Есть вопрос»", () => {
    const text = html(REPORT);
    expect(text).toContain("Подтверждаю");
    expect(text).toContain("Есть вопрос");
    expect(text).not.toContain("Изменить решение");
  });

  it("после решения — «Изменить решение» вместо кнопок", () => {
    const text = html(CONFIRMED);
    expect(text).toContain("Изменить решение");
    expect(text).not.toContain("Подтверждаю");
  });

  it("после выплаты «Изменить решение» и кнопки скрыты", () => {
    const text = html(PAID);
    expect(text).not.toContain("Изменить решение");
    expect(text).not.toContain("Подтверждаю");
    expect(text).not.toContain("Есть вопрос");
  });

  it("окно вопроса: поле комментария и кнопка отправки выключена, пока комментария нет", () => {
    const text = html(REPORT, { initialDisputing: true });
    expect(text).toContain("Что не сходится");
    expect(text).toMatch(/<button[^>]*disabled[^>]*>Отправить вопрос/);
  });

  it("у оспоренного окно открывается с прежним комментарием", () => {
    const text = renderToStaticMarkup(createElement(ClosedMonth, { report: DISPUTED, busy: false, error: null, initialDisputing: true, onDecide: () => undefined }));
    expect(text).toContain("Не сходятся расходы на серверы");
  });

  it("ответ сервера 409 показывается его текстом", () => {
    const error: ApiError = { kind: "rejected", status: 409, code: "ledger_confirmation_paid", message: "Выплата по месяцу уже проведена — решение не меняется", requestId: null, reason: null };
    expect(html(REPORT, { error })).toContain("Выплата по месяцу уже проведена — решение не меняется");
  });
});

describe("комментарий спора", () => {
  it("пустой и короче трёх знаков не уходит", () => {
    expect(disputeProblem("")).not.toBeNull();
    expect(disputeProblem("   ")).not.toBeNull();
    expect(disputeProblem("ab")).not.toBeNull();
  });

  it("от трёх знаков уходит, длиннее тысячи — нет", () => {
    expect(disputeProblem("abc")).toBeNull();
    expect(disputeProblem("  не сходится  ")).toBeNull();
    expect(disputeProblem("я".repeat(1_001))).not.toBeNull();
  });
});

describe("запросы", () => {
  function apiWith(respond: (url: string, init: RequestInit) => unknown, status = 200) {
    const calls: { url: string; init: RequestInit }[] = [];
    const api = new AdminApi(async (url, init) => {
      calls.push({ url, init });
      const body = respond(url, init);
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    });
    return { api, calls };
  }

  it("отчёт месяца — GET по адресу месяца", async () => {
    const { api, calls } = apiWith(() => ({ data: REPORT }));
    const result = await loadMyReport(api, "2026-10");
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe("/api/v1/admin/my-project/periods/2026-10");
  });

  it("подтверждение уходит без комментария", async () => {
    const { api, calls } = apiWith(() => ({ data: CONFIRMED }));
    await decideMyReport(api, "2026-10", "confirmed");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ decision: "confirmed" });
  });

  it("спор уходит с комментарием без лишних пробелов", async () => {
    const { api, calls } = apiWith(() => ({ data: DISPUTED }));
    await decideMyReport(api, "2026-10", "disputed", "  Не сходятся расходы  ");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ decision: "disputed", comment: "Не сходятся расходы" });
  });

  it("409 сервера приходит ошибкой с его текстом", async () => {
    const { api } = apiWith(() => ({ error: { code: "ledger_confirmation_paid", message: "Выплата уже проведена" } }), 409);
    const result = await decideMyReport(api, "2026-10", "confirmed");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(409);
      expect(result.error.message).toBe("Выплата уже проведена");
    }
  });
});

describe("экран месяца", () => {
  const PROJECT: MyProject = {
    month: "2026-10",
    months: ["2026-11", "2026-10", "2026-09"],
    viewer: { role: "stakeholder", sharePercent: 25, shareFrom: "2026-09" },
    participants: [{ name: "Анна", sharePercent: 25, me: true }],
    ownerSharePercent: 75,
    rates: null,
    project: {
      revenue: { stars: { paid: 0, refunded: 0, net: 0 }, byPlatform: [], bySource: [], usd: "0.00", rub: "0.00" },
      hold: { days: 21, inHoldStars: 0, releasedStars: 0, nextReleaseAt: null },
      draft: { sharePercent: 25, usd: "1.00", rub: "90.00", stars: 80 },
    },
  };
  const screen = (props: Record<string, unknown>) => plain(renderToStaticMarkup(createElement(MyProjectContent, { data: PROJECT, onMonth: () => undefined, ...props })));

  it("закрытый месяц заменяет черновик", () => {
    const text = screen({ state: { status: "closed", report: REPORT }, busy: false, decideError: null, onDecide: () => undefined });
    expect(text).toContain("Ждёт твоего подтверждения");
    expect(text).not.toContain("Черновик моей части");
  });

  it("открытый месяц — черновик, как раньше", () => {
    expect(screen({ state: { status: "draft" } })).toContain("Черновик моей части");
    expect(screen({})).toContain("Черновик моей части");
  });

  it("пока отчёт грузится, черновика нет: он не мигает перед отчётом", () => {
    const text = screen({ state: { status: "loading" } });
    expect(text).not.toContain("Черновик моей части");
  });

  it("в списке месяцев метка «ждёт подтверждения»", () => {
    const text = screen({ awaiting: new Set(["2026-09"]) });
    expect(text).toMatch(/сентябрь 2026[^<]*ждёт подтверждения/);
    expect(text).not.toMatch(/октябрь 2026[^<]*ждёт подтверждения/);
  });
});
