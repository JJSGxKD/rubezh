import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { approveChange, fetchChangeRequests, proposeChange, rejectChange, withdrawChange, type ChangeRequest, type ChangeTarget } from "../src/api/change-requests";
import { TABS } from "../src/screens/balance/balance-tables";
import { ChangeRequestList } from "../src/screens/balance/prices/ChangeRequestList";
import { PRICES_TAB, describeChange, emptyProposal, isPricesTab, proposalAfter, proposalProblem, requestActions, requestStatusTitle, timeLeft, withPricesTab } from "../src/screens/balance/prices/prices-rules";
import { fakeFetch, json } from "./helpers";

// Вкладка «Цены и награды» раздела «Баланс» (tasks/T-0309): заявка «было → стало»
// с причиной, подтверждает другой человек; у автора кнопки «Подтвердить» нет.

const NOW = new Date(Date.UTC(2026, 10, 13, 9));
const HOUR = 3_600_000;
const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";

function request(patch: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    requestId: ID,
    kind: "sku_price",
    target: "gems_60",
    before: { stars: 50 },
    after: { stars: 60 },
    reason: "Малый набор дешевле соседнего за штуку",
    author: OTHER,
    authorName: "Аня",
    status: "pending",
    decidedBy: null,
    decidedByName: null,
    decidedAt: null,
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 72 * HOUR).toISOString(),
    ...patch,
  };
}

const TARGET: ChangeTarget = {
  target: "gems_60",
  title: "60 самоцветов",
  current: { stars: 50, baseRub: "86", contents: { gems: 60 }, badge: null, sort: 20 },
  inCode: { stars: 50, baseRub: "86", contents: { gems: 60 }, badge: null, sort: 20 },
  overridden: false,
};

function list(requests: ChangeRequest[], meId = ME): string {
  return renderToStaticMarkup(
    createElement(ChangeRequestList, {
      requests,
      meId,
      now: NOW,
      titleOf: (_kind: string, target: string) => (target === "gems_60" ? "60 самоцветов" : target),
      busy: null,
      onApprove: () => undefined,
      onReject: () => undefined,
      onWithdraw: () => undefined,
    }),
  );
}

describe("кто что может с заявкой", () => {
  it("у автора нет «Подтвердить» и «Отклонить» — только «Отозвать»", () => {
    expect(requestActions(request({ author: ME }), ME, NOW)).toEqual({ approve: false, reject: false, withdraw: true });
    const html = list([request({ author: ME })]);
    expect(html).not.toContain("Подтвердить");
    expect(html).not.toContain("Отклонить");
    expect(html).toContain("Отозвать");
  });

  it("у другого участника — «Подтвердить» и «Отклонить», «Отозвать» нет", () => {
    expect(requestActions(request(), ME, NOW)).toEqual({ approve: true, reject: true, withdraw: false });
    const html = list([request()]);
    expect(html).toContain("Подтвердить");
    expect(html).toContain("Отклонить");
    expect(html).not.toContain("Отозвать");
  });

  it("закрытые и просроченные заявки действий не дают", () => {
    for (const status of ["approved", "rejected", "expired", "superseded"] as const) {
      expect(requestActions(request({ status }), ME, NOW), status).toEqual({ approve: false, reject: false, withdraw: false });
      expect(requestActions(request({ status, author: ME }), ME, NOW), status).toEqual({ approve: false, reject: false, withdraw: false });
    }
    // Сервер ещё не пометил, но срок вышел: кнопки уже не нужны.
    const late = new Date(NOW.getTime() + 72 * HOUR);
    expect(requestActions(request(), ME, late)).toEqual({ approve: false, reject: false, withdraw: false });
    expect(requestActions(request(), ME, new Date(late.getTime() - 1))).toEqual({ approve: true, reject: true, withdraw: false });
    const html = list([request({ status: "approved" }), request({ requestId: "x", status: "expired" })]);
    expect(html).not.toContain("Подтвердить");
    expect(html).not.toContain("Отозвать");
  });
});

describe("список заявок", () => {
  it("строка называет автора, товар, «было → стало», причину и срок", () => {
    const html = list([request()]);
    expect(html).toContain("Аня");
    expect(html).toContain("60 самоцветов");
    expect(html).toContain("цена 50 → 60 ⭐");
    expect(html).toContain("Малый набор дешевле соседнего за штуку");
    expect(html).toContain("ещё 3 дн");
  });

  it("пусто — понятная строка; закрытая показывает, чем кончилось и кто решил", () => {
    expect(list([])).toContain("Заявок пока нет");
    const approved = list([request({ status: "approved", decidedBy: OTHER, decidedByName: "Боря", decidedAt: NOW.toISOString() })]);
    expect(approved).toContain("Подтверждена");
    expect(approved).toContain("Боря");
  });

  it("отзыв автором — «Отозвана», отказ другого — «Отклонена»", () => {
    expect(requestStatusTitle(request({ status: "rejected", decidedBy: OTHER }))).toBe("Отозвана");
    expect(requestStatusTitle(request({ status: "rejected", decidedBy: ME }))).toBe("Отклонена");
    expect(requestStatusTitle(request({ status: "pending" }))).toBe("Ждёт подтверждения");
    expect(requestStatusTitle(request({ status: "expired" }))).toBe("Истекла");
    expect(requestStatusTitle(request({ status: "superseded" }))).toBe("Заменена новой");
  });

  it("срок: часы и дни, просроченная — «истекла»", () => {
    expect(timeLeft(request(), NOW)).toBe("ещё 3 дн");
    expect(timeLeft(request(), new Date(NOW.getTime() + 50 * HOUR))).toBe("ещё 22 ч");
    expect(timeLeft(request(), new Date(NOW.getTime() + 71 * HOUR + 30 * 60_000))).toBe("меньше часа");
    expect(timeLeft(request(), new Date(NOW.getTime() + 72 * HOUR))).toBe("истекла");
  });
});

describe("«было → стало» словами", () => {
  it("цена, самоцветы, значок, порядок — по строке на поле", () => {
    expect(describeChange("sku_price", { stars: 50 }, { stars: 60 })).toEqual(["цена 50 → 60 ⭐"]);
    expect(describeChange("sku_price", { baseRub: "86" }, { baseRub: "99" })).toEqual(["цена 86 → 99 ₽"]);
    expect(describeChange("sku_price", { contents: { gems: 330 }, badge: "hit", sort: 30 }, { contents: { gems: 360 }, badge: null, sort: 35 })).toEqual([
      "самоцветов 330 → 360",
      "значок «Хит» → нет",
      "порядок 30 → 35",
    ]);
    // Незнакомый вид показывается как есть, а не пустотой.
    expect(describeChange("other", { x: 1 }, { x: 2 })[0]).toContain("x");
  });
});

describe("форма заявки", () => {
  it("пустая форма — текущие значения товара, ничего не изменено: отправить нельзя", () => {
    const draft = emptyProposal(TARGET);
    expect(draft).toMatchObject({ stars: "50", baseRub: "86", gems: "60", badge: "", sort: "20", reason: "" });
    expect(proposalAfter(draft, TARGET)).toEqual({});
    expect(proposalProblem(draft, TARGET)).toMatch(/Ничего не изменено/);
  });

  it("в заявку идут только изменённые поля, в формате сервера", () => {
    const draft = { ...emptyProposal(TARGET), stars: "60", gems: "70", badge: "hit", reason: "причина" };
    expect(proposalAfter(draft, TARGET)).toEqual({ stars: 60, contents: { gems: 70 }, badge: "hit" });
    expect(proposalAfter({ ...emptyProposal(TARGET), sort: "25", baseRub: "99.50" }, TARGET)).toEqual({ sort: 25, baseRub: "99.50" });
    // Значок снимают пустым выбором; пока выбор прежний, поле не идёт.
    const hit: ChangeTarget = { ...TARGET, current: { ...(TARGET.current as Record<string, unknown>), badge: "hit" } };
    expect(emptyProposal(hit).badge).toBe("hit");
    expect(proposalAfter(emptyProposal(hit), hit)).toEqual({});
    expect(proposalAfter({ ...emptyProposal(hit), badge: "" }, hit)).toEqual({ badge: null });
  });

  it("правила каталога видны до отправки: цена 0, дробная, выше потолка; самоцветов ноль; причина обязательна", () => {
    const base = { ...emptyProposal(TARGET), reason: "причина" };
    expect(proposalProblem({ ...base, stars: "0" }, TARGET)).toMatch(/Цена в звёздах.*от 1 до 10 000/);
    expect(proposalProblem({ ...base, stars: "12,5" }, TARGET)).toMatch(/Цена в звёздах/);
    expect(proposalProblem({ ...base, stars: "10001" }, TARGET)).toMatch(/Цена в звёздах/);
    expect(proposalProblem({ ...base, stars: "" }, TARGET)).toMatch(/Цена в звёздах/);
    expect(proposalProblem({ ...base, gems: "0", stars: "60" }, TARGET)).toMatch(/Самоцветов в наборе/);
    expect(proposalProblem({ ...base, baseRub: "бесплатно", stars: "60" }, TARGET)).toMatch(/Цена в рублях/);
    expect(proposalProblem({ ...base, stars: "60", reason: "   " }, TARGET)).toMatch(/причин/i);
    expect(proposalProblem({ ...base, stars: "60", reason: "я".repeat(201) }, TARGET)).toMatch(/200/);
    expect(proposalProblem({ ...base, stars: "60" }, TARGET)).toBeNull();
  });
});

describe("вкладка в разделе «Баланс»", () => {
  it("«Цены и награды» — девятая вкладка, таблицы баланса остаются как были", () => {
    expect(PRICES_TAB).toEqual({ id: "prices", title: "Цены и награды" });
    expect(isPricesTab("prices")).toBe(true);
    expect(isPricesTab("enemies")).toBe(false);
    expect(isPricesTab(undefined)).toBe(false);
    const tabs = withPricesTab(TABS);
    expect(tabs).toHaveLength(TABS.length + 1);
    expect(tabs.at(-1)).toEqual(PRICES_TAB);
    expect(tabs.slice(0, -1)).toEqual([...TABS]);
  });
});

describe("запросы к серверу", () => {
  it("обзор — GET, заявка — POST с видом, целью, правкой и причиной; подтвердить, отклонить, отозвать — по адресам заявки", async () => {
    const overview = { requests: [request()], targets: { sku_price: [TARGET] }, ttlHours: 72 };
    const { fetch, calls } = fakeFetch(json(200, { data: overview }), json(201, { data: request() }), json(201, { data: request() }), json(201, { data: request() }), json(201, { data: request() }));
    const api = new AdminApi(fetch);

    const loaded = await fetchChangeRequests(api);
    expect(loaded.ok && loaded.data.targets.sku_price?.[0]?.target).toBe("gems_60");
    expect(calls[0]?.url).toBe("/api/v1/admin/change-requests");

    await proposeChange(api, { kind: "sku_price", target: "gems_60", after: { stars: 60 }, reason: "  причина  " });
    expect(calls[1]?.url).toBe("/api/v1/admin/change-requests");
    expect(calls[1]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ kind: "sku_price", target: "gems_60", after: { stars: 60 }, reason: "причина" });

    await approveChange(api, ID);
    await rejectChange(api, ID);
    await withdrawChange(api, ID);
    expect(calls.slice(2).map((call) => [call.init.method, call.url])).toEqual([
      ["POST", `/api/v1/admin/change-requests/${ID}/approve`],
      ["POST", `/api/v1/admin/change-requests/${ID}/reject`],
      ["POST", `/api/v1/admin/change-requests/${ID}/withdraw`],
    ]);
  });

  it("409 «цель изменилась» приходит ошибкой с текстом сервера, а не пустотой", async () => {
    const { fetch } = fakeFetch(json(409, { error: { code: "change_request_stale", message: "Цена изменилась после заявки — заявка заменена" } }));
    const result = await approveChange(new AdminApi(fetch), ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("change_request_stale");
      expect(result.error.message).toContain("Цена изменилась");
    }
  });

  it("ответ не по схеме — «ответ не разобрался», а не пустая таблица", async () => {
    const { fetch } = fakeFetch(json(200, { data: { requests: [{ requestId: 1 }], targets: {}, ttlHours: 72 } }));
    const result = await fetchChangeRequests(new AdminApi(fetch));
    expect(result.ok).toBe(false);
  });
});
