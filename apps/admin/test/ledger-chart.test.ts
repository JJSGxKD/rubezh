import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import {
  archivePlace,
  articleGroups,
  bpToPercent,
  feeLabel,
  feeToInput,
  loadPlaces,
  percentToBp,
  placesSchema,
  scheduleLabel,
  templatesSchema,
  type Article,
  type Place,
  type Template,
} from "../src/api/ledger-chart";
import { ArticlesView } from "../src/screens/ledger/chart/ArticlesView";
import { PlacesView } from "../src/screens/ledger/chart/PlacesView";
import { TemplatesView } from "../src/screens/ledger/chart/TemplatesView";
import { fakeFetch, json } from "./helpers";

/**
 * «Места и статьи» и «Шаблоны» в «Бухгалтерии» (tasks/T-0465, Р220): шаблон комиссии и график человеческим
 * языком, права на изменение и текст отказа архива под кнопкой.
 */

const plain = (text: string) => text.replace(/[  ]/g, " ");
const noop = () => undefined;

const PLACE: Place = {
  placeId: "bank.t-banka",
  name: "Карта Т-Банка",
  currency: "RUB",
  archived: false,
  balance: "1500.00",
  fee: null,
  accounts: [{ accountId: "bank.t-banka", name: "Карта Т-Банка", balance: "1500.00" }],
};
const WALLET: Place = { ...PLACE, placeId: "wallet.ton", name: "Кошелёк TON", currency: "GRAM", balance: "12.5", fee: { percentBp: 200, fixed: "0.05", fixedCurrency: "GRAM" } };

const ARTICLES: Article[] = [
  { articleId: "vps", kind: "expense", name: "Сервер", system: false, archived: false },
  { articleId: "fee_withdrawal", kind: "expense", name: "Комиссия вывода", system: true, archived: false },
  { articleId: "ads_adsgram", kind: "income", name: "Реклама Adsgram", system: true, archived: false },
  { articleId: "old", kind: "expense", name: "Старая", system: false, archived: true },
];

const TEMPLATE: Template = {
  templateId: "t1",
  name: "VPS",
  articleId: "vps",
  articleName: "Сервер",
  placeAccountId: "bank.t-banka",
  placeName: "Карта Т-Банка",
  currency: "RUB",
  amount: "1500.00",
  schedule: "monthly",
  month: null,
  note: null,
  archived: false,
};

describe("подпись шаблона комиссии", () => {
  it("процент, фикса, оба и без комиссии", () => {
    expect(feeLabel({ percentBp: 200, fixed: null, fixedCurrency: null })).toBe("2 %");
    expect(feeLabel({ percentBp: 250, fixed: null, fixedCurrency: null })).toBe("2,5 %");
    expect(plain(feeLabel({ percentBp: null, fixed: "0.05", fixedCurrency: "GRAM" }))).toBe("0,05 Gram");
    expect(plain(feeLabel({ percentBp: 200, fixed: "0.05", fixedCurrency: "GRAM" }))).toBe("2 % + 0,05 Gram");
    expect(feeLabel(null)).toBe("без комиссии");
    expect(feeLabel({ percentBp: null, fixed: null, fixedCurrency: null })).toBe("без комиссии");
    expect(feeLabel({ percentBp: 0, fixed: null, fixedCurrency: null })).toBe("без комиссии");
  });

  it("фикса в рублях — со знаком, хвост нулей срезается", () => {
    expect(plain(feeLabel({ percentBp: null, fixed: "50.00", fixedCurrency: "RUB" }))).toBe("50 ₽");
  });
});

describe("процент в сотых долях", () => {
  it("«2,5» → 250 и обратно; мусор и выход за 0…100 отвергаются", () => {
    expect(percentToBp("2,5")).toBe(250);
    expect(percentToBp("2.5")).toBe(250);
    expect(percentToBp("")).toBeNull();
    expect(percentToBp("abc")).toBe("invalid");
    expect(percentToBp("101")).toBe("invalid");
    expect(percentToBp("1,234")).toBe("invalid");
    expect(bpToPercent(250)).toBe("2,5");
    expect(bpToPercent(200)).toBe("2");
  });

  it("форма комиссии: пустая — без комиссии, мусор — ошибка", () => {
    expect(feeToInput({ percent: "", fixed: "", fixedCurrency: "RUB" })).toEqual({ ok: true, fee: null });
    expect(feeToInput({ percent: "2", fixed: "0,05", fixedCurrency: "GRAM" })).toEqual({ ok: true, fee: { percentBp: 200, fixed: "0.05", fixedCurrency: "GRAM" } });
    expect(feeToInput({ percent: "x", fixed: "", fixedCurrency: "RUB" }).ok).toBe(false);
    expect(feeToInput({ percent: "", fixed: "-1", fixedCurrency: "RUB" }).ok).toBe(false);
  });
});

describe("подпись графика", () => {
  it("каждый месяц и каждый март", () => {
    expect(scheduleLabel("monthly", null)).toBe("каждый месяц");
    expect(scheduleLabel("yearly", 3)).toBe("каждый март");
    expect(scheduleLabel("yearly", 12)).toBe("каждый декабрь");
    expect(scheduleLabel("yearly", null)).toBe("раз в год");
  });
});

describe("разбор ответов", () => {
  it("места и шаблоны разбираются схемой", () => {
    expect(placesSchema.safeParse({ places: [PLACE, WALLET] }).success).toBe(true);
    expect(templatesSchema.safeParse({ templates: [TEMPLATE] }).success).toBe(true);
    expect(templatesSchema.safeParse({ templates: [{ ...TEMPLATE, schedule: "weekly" }] }).success).toBe(false);
  });

  it("запрос мест идёт на /ledger/places", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { places: [PLACE] } }));
    const result = await loadPlaces(new AdminApi(fetch));
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toContain("/ledger/places");
  });
});

describe("статьи", () => {
  it("два списка, архивные не показываются", () => {
    const groups = articleGroups(ARTICLES);
    expect(groups.expense.map((a) => a.articleId)).toEqual(["vps", "fee_withdrawal"]);
    expect(groups.income.map((a) => a.articleId)).toEqual(["ads_adsgram"]);
  });
});

describe("права на изменение", () => {
  const places = (canEdit: boolean) => plain(renderToStaticMarkup(createElement(PlacesView, { places: [PLACE, WALLET], canEdit, notes: {}, onAdd: noop, onEdit: noop, onArchive: noop })));
  const articles = (canEdit: boolean) => plain(renderToStaticMarkup(createElement(ArticlesView, { articles: ARTICLES, canEdit, notes: {}, onAdd: noop, onRename: noop, onArchive: noop })));
  const templates = (canEdit: boolean) => plain(renderToStaticMarkup(createElement(TemplatesView, { templates: [TEMPLATE], canEdit, notes: {}, onAdd: noop, onEdit: noop, onArchive: noop })));

  it("с правом кнопки есть", () => {
    expect(places(true)).toContain("Добавить место");
    expect(places(true)).toContain("Изменить");
    expect(places(true)).toContain("В архив");
    expect(articles(true)).toContain("Добавить статью");
    expect(articles(true)).toContain("Переименовать");
    expect(templates(true)).toContain("Добавить шаблон");
    expect(templates(true)).toContain("Изменить");
  });

  it("без права кнопок изменения нет, а данные видны", () => {
    for (const html of [places(false), articles(false), templates(false)]) {
      expect(html).not.toContain("Добавить");
      expect(html).not.toContain("Изменить");
      expect(html).not.toContain("Переименовать");
      expect(html).not.toContain("В архив");
    }
    expect(places(false)).toContain("Карта Т-Банка");
    expect(places(false)).toContain("2 % + 0,05 Gram");
    expect(articles(false)).toContain("служебная");
    expect(templates(false)).toContain("каждый месяц");
  });

  it("архивные статьи не рисуются, у служебной метка и нет кнопок", () => {
    const html = articles(true);
    expect(html).not.toContain("Старая");
    expect(html).toContain("служебная");
  });
});

describe("архив", () => {
  it("ответ 409 приходит текстом сервера и показывается под кнопкой", async () => {
    const message = "На месте остаток — сначала переведите деньги";
    const { fetch } = fakeFetch(json(409, { error: { code: "LEDGER_PLACE_HAS_BALANCE", message } }));
    const result = await archivePlace(new AdminApi(fetch), "bank.t-banka");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(409);
    expect(result.error.message).toBe(message);

    const html = plain(renderToStaticMarkup(createElement(PlacesView, { places: [PLACE], canEdit: true, notes: { "bank.t-banka": result.error.message }, onAdd: noop, onEdit: noop, onArchive: noop })));
    expect(html).toContain(message);
  });
});

describe("пустое состояние шаблонов", () => {
  it("называет, что завести", () => {
    const html = plain(renderToStaticMarkup(createElement(TemplatesView, { templates: [], canEdit: true, notes: {}, onAdd: noop, onEdit: noop, onArchive: noop })));
    expect(html).toContain("Шаблонов пока нет. Заведите сервер, CDN и ИИ-инструменты — каждый месяц они будут появляться черновиками");
  });
});
