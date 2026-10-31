import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import {
  PARTNER_CODE_ROUTE,
  PARTNER_STATUSES,
  STATUS_TITLES,
  bindsNewPlayers,
  createPartner,
  emptyPartnerForm,
  fetchPartner,
  fetchPartnerFunnel,
  fetchPartners,
  filterPartners,
  funnelRowOf,
  partnerFormOf,
  partnerFormSchema,
  partnerFunnelSchema,
  partnerOfRoute,
  setPartnerStatus,
  share,
  sourceTitle,
  statusTone,
  updatePartner,
} from "../src/api/partners";
import { funnelBars } from "../src/api/funnel";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

// Партнёры в панели (docs/35-stage4-plan.md WP41, часть 2; Р96): адреса и тела
// запросов, пустые поля формы уходят как null, доли без деления на ноль,
// маршрут мастера промокода с выбранным партнёром, условия партнёра (TG id,
// страна, валюта, способ и процент) и статус с тоном значка и фильтром.

const PARTNER = {
  partnerId: "0c4a5c1e-6a57-4d43-8a2a-0f3f6d0a9b10",
  name: "Канал",
  contact: "@channel",
  note: null,
  createdAt: "2026-10-02T09:00:00.000Z",
  updatedAt: "2026-10-02T09:00:00.000Z",
  telegramId: null,
  status: "active" as const,
  country: null,
  payoutCurrency: null,
  payoutMethod: null,
  sharePercent: null,
  stats: { codes: 1, activeCodes: 1, redeemed: 10, bound: 4, played: 3, payers: 1, stars: 250 },
};

const FORM = { ...emptyPartnerForm(), name: "Канал" };

describe("партнёры в панели", () => {
  it("раздел — под правом смотреть партнёров", () => {
    expect(SECTIONS.find((section) => section.id === "partners")?.permission).toBe("partners.view");
  });

  it("список, карточка, заведение и правка — по своим адресам; пустые связь и заметка — null", async () => {
    const { fetch, calls } = fakeFetch(
      json(200, { data: { partners: [PARTNER], rules: { bindWindowDays: 7 } } }),
      json(200, { data: { partner: PARTNER, daily: [{ day: "2026-10-02", count: 4 }], codes: [], rules: { bindWindowDays: 7 } } }),
      json(201, { data: PARTNER }),
      json(201, { data: { ...PARTNER, name: "Канал 2" } }),
    );
    const api = new AdminApi(fetch);
    const list = await fetchPartners(api);
    expect(list.ok && list.data.partners[0]?.stats.bound).toBe(4);
    expect(calls[0]?.url).toBe("/api/v1/admin/partners");
    const detail = await fetchPartner(api, PARTNER.partnerId);
    expect(detail.ok && detail.data.daily).toHaveLength(1);
    expect(calls[1]?.url).toBe(`/api/v1/admin/partners/${PARTNER.partnerId}`);

    await createPartner(api, { ...FORM, name: " Канал ", contact: "", note: "  " });
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({
      name: "Канал",
      contact: null,
      note: null,
      telegramId: null,
      country: null,
      payoutCurrency: null,
      payoutMethod: null,
      sharePercent: null,
    });
    await updatePartner(api, PARTNER.partnerId, { ...partnerFormOf(PARTNER), name: "Канал 2" });
    expect(calls[3]?.url).toBe(`/api/v1/admin/partners/${PARTNER.partnerId}`);
    expect(JSON.parse(String(calls[3]?.init.body))).toMatchObject({ name: "Канал 2", contact: "@channel", note: null, telegramId: null, sharePercent: null });
  });

  it("условия партнёра: разбираются из ответа, уходят в теле — страна заглавными, пробелы срезаны, пустое — null", async () => {
    const terms = { telegramId: "424242", status: "paused" as const, country: "KZ", payoutCurrency: "USDT", payoutMethod: "USDT TRC-20 на T9yX", sharePercent: "12.50" };
    const { fetch, calls } = fakeFetch(
      json(200, { data: { partners: [{ ...PARTNER, ...terms }], rules: { bindWindowDays: 7 } } }),
      json(201, { data: { ...PARTNER, ...terms } }),
    );
    const api = new AdminApi(fetch);
    const list = await fetchPartners(api);
    expect(list.ok && list.data.partners[0]).toMatchObject(terms);

    const created = await createPartner(api, { ...FORM, telegramId: " 424242 ", country: "kz", payoutCurrency: "USDT", payoutMethod: " USDT TRC-20 на T9yX ", sharePercent: " 12.5 " });
    expect(created.ok && created.data.sharePercent).toBe("12.50");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      name: "Канал",
      contact: null,
      note: null,
      telegramId: "424242",
      country: "KZ",
      payoutCurrency: "USDT",
      payoutMethod: "USDT TRC-20 на T9yX",
      sharePercent: "12.5",
    });
    // Форма правки — из карточки: пустое поле — пустая строка, а не «null».
    expect(partnerFormOf(PARTNER)).toEqual({ name: "Канал", contact: "@channel", note: "", telegramId: "", country: "", payoutCurrency: "", payoutMethod: "", sharePercent: "" });
    expect(partnerFormOf({ ...PARTNER, ...terms })).toMatchObject({ telegramId: "424242", country: "KZ", payoutCurrency: "USDT", sharePercent: "12.50" });
  });

  it("статус, которого панель не знает, — не молчаливое «активен», а понятная ошибка версий", async () => {
    const { fetch } = fakeFetch(json(200, { data: { partners: [{ ...PARTNER, status: "banned" }], rules: { bindWindowDays: 7 } } }));
    const list = await fetchPartners(new AdminApi(fetch));
    expect(list.ok).toBe(false);
  });

  it("смена статуса — PUT с причиной без лишних пробелов; ответ — партнёр с новым статусом", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { ...PARTNER, status: "paused" } }));
    const result = await setPartnerStatus(new AdminApi(fetch), PARTNER.partnerId, "paused", "  Не выходит на связь ");
    expect(calls[0]?.url).toBe(`/api/v1/admin/partners/${PARTNER.partnerId}/status`);
    expect(calls[0]?.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ status: "paused", reason: "Не выходит на связь" });
    expect(result.ok && result.data.status).toBe("paused");
  });

  it("статус значком: активен — успех, заявка — сведения, приостановлен — предупреждение, отклонён — приглушённый; привязывает только активный", () => {
    expect(PARTNER_STATUSES).toEqual(["applied", "active", "paused", "rejected"]);
    expect(PARTNER_STATUSES.map((status) => [status, statusTone(status), STATUS_TITLES[status]])).toEqual([
      ["applied", "info", "заявка"],
      ["active", "success", "активен"],
      ["paused", "warning", "приостановлен"],
      ["rejected", "neutral", "отклонён"],
    ]);
    for (const status of PARTNER_STATUSES) expect(bindsNewPlayers(status), status).toBe(status === "active");
  });

  it("список по статусу: по умолчанию все, кроме отклонённых; «все» показывает и их; один статус — только он", () => {
    const rows = PARTNER_STATUSES.map((status, index) => ({ ...PARTNER, partnerId: `p${String(index)}`, status }));
    expect(filterPartners(rows, "visible").map((row) => row.status)).toEqual(["applied", "active", "paused"]);
    expect(filterPartners(rows, "all").map((row) => row.status)).toEqual(["applied", "active", "paused", "rejected"]);
    expect(filterPartners(rows, "rejected").map((row) => row.status)).toEqual(["rejected"]);
    expect(filterPartners(rows, "active").map((row) => row.status)).toEqual(["active"]);
    expect(filterPartners([], "visible")).toEqual([]);
  });

  it("форма: имя обязательно и не длиннее 80; пустая форма — для нового", () => {
    expect(emptyPartnerForm()).toEqual({ name: "", contact: "", note: "", telegramId: "", country: "", payoutCurrency: "", payoutMethod: "", sharePercent: "" });
    expect(partnerFormSchema.safeParse({ ...FORM, name: "К" }).success).toBe(false);
    expect(partnerFormSchema.safeParse({ ...FORM, name: "x".repeat(81) }).success).toBe(false);
    expect(partnerFormSchema.safeParse(FORM).success).toBe(true);
  });

  it("форма, условия: TG id — до двадцати цифр, страна — две буквы, валюта — из списка ядра курсов, способ — до 200, процент — от 0 до 100 с двумя знаками; пустое можно", () => {
    const ok = { telegramId: "1".repeat(20), country: "kz", payoutCurrency: "USDT", payoutMethod: "x".repeat(200), sharePercent: "100.00" };
    expect(partnerFormSchema.safeParse({ ...FORM, ...ok }).success).toBe(true);
    for (const currency of ["USD", "EUR", "RUB", "GRAM", "USDT", "XTR"]) expect(partnerFormSchema.safeParse({ ...FORM, payoutCurrency: currency }).success, currency).toBe(true);
    for (const bad of [
      { telegramId: "12ab" },
      { telegramId: "1".repeat(21) },
      { country: "RUS" },
      { country: "р" },
      { payoutCurrency: "BTC" },
      { payoutCurrency: "usd" },
      { payoutMethod: "x".repeat(201) },
      { sharePercent: "100.01" },
      { sharePercent: "abc" },
      { sharePercent: "5.123" },
      { sharePercent: "-1" },
    ]) {
      expect(partnerFormSchema.safeParse({ ...FORM, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("доля от приведённых — процентом, от нуля — прочерк; маршрут мастера с партнёром разбирается обратно", () => {
    expect(share(3, 4)).toBe("75%");
    expect(share(0, 0)).toBe("—");
    expect(partnerOfRoute(`${PARTNER_CODE_ROUTE}${PARTNER.partnerId}`)).toBe(PARTNER.partnerId);
    expect(partnerOfRoute(null)).toBeNull();
    expect(partnerOfRoute(PARTNER.partnerId)).toBeNull();
  });
});

describe("воронка партнёра в карточке (T-0068, Р96)", () => {
  const counts = (patch: Partial<Record<string, number>> = {}) => ({ accounts: 0, entered: 0, appOpened: 0, firstRunStarted: 0, firstRunFinished: 0, runs2: 0, runs5: 0, returnedD1: 0, returnedD7: 0, firstPurchase: 0, ...patch });
  const FUNNEL = {
    from: "2026-10-01T00:00:00.000Z",
    to: "2026-10-31T00:00:00.000Z",
    total: counts({ accounts: 3, entered: 3, appOpened: 3, firstRunStarted: 2, firstRunFinished: 1, firstPurchase: 1 }),
    sources: [
      { via: "link", name: "channel-post", ref: "AbCd1234", counts: counts({ accounts: 2, entered: 2, appOpened: 2, firstRunStarted: 1, firstRunFinished: 1 }) },
      { via: "code", name: "Стрим", ref: "11111111-1111-4111-8111-111111111111", counts: counts({ accounts: 1, entered: 1, appOpened: 1, firstRunStarted: 1, firstPurchase: 1 }) },
    ],
    platforms: [{ platform: "telegram", counts: counts({ accounts: 3, entered: 3 }) }],
  };

  it("fetchPartnerFunnel: адрес с периодом и id в пути; ответ разобран схемой", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: FUNNEL }));
    const api = new AdminApi(fetch);

    const result = await fetchPartnerFunnel(api, "0c4a5c1e-6a57-4d43-8a2a-0f3f6d0a9b10", { from: "2026-10-01T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" });

    expect(calls[0]?.url).toBe("/api/v1/admin/partners/0c4a5c1e-6a57-4d43-8a2a-0f3f6d0a9b10/funnel?from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-31T00%3A00%3A00.000Z");
    expect(result.ok && result.data.sources).toHaveLength(2);
    expect(result.ok && result.data.total.accounts).toBe(3);
    expect(partnerFunnelSchema.parse(FUNNEL)).toEqual(FUNNEL);
  });

  it("ответ без вех или с неизвестным видом источника — ошибка разбора, а не пустая таблица", async () => {
    const { fetch } = fakeFetch(json(200, { data: { ...FUNNEL, total: { accounts: 3 } } }), json(200, { data: { ...FUNNEL, sources: [{ ...FUNNEL.sources[0], via: "email" }] } }));
    const api = new AdminApi(fetch);

    expect((await fetchPartnerFunnel(api, "x", {})).ok).toBe(false);
    expect((await fetchPartnerFunnel(api, "x", {})).ok).toBe(false);
  });

  it("без периода запрос идёт без параметров: умолчание — тридцать суток — решает сервер", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: FUNNEL }));
    await fetchPartnerFunnel(new AdminApi(fetch), "abc", {});
    expect(calls[0]?.url).toBe("/api/v1/admin/partners/abc/funnel");
  });

  it("funnelRowOf: вехи партнёра встают в строку воронки, и полосы считаются теми же funnelBars, что на экране «Воронка»", () => {
    const row = funnelRowOf(FUNNEL.total, "Все игроки партнёра");
    expect(row).toMatchObject({ platform: "все", startKind: "все", accounts: 3, entered: 3, firstRunStarted: 2, firstPurchase: 1 });
    const bars = funnelBars(row, null);
    expect(bars).toHaveLength(9);
    expect(bars[0]).toMatchObject({ step: "entered", count: 3, ofFirst: 1 });
    expect(bars[2]).toMatchObject({ step: "firstRunStarted", count: 2 });
    expect(Math.round((bars[2]?.ofFirst ?? 0) * 100)).toBe(67);
  });

  it("sourceTitle: ссылка — кампания и код, код — название кампании промокода; удалённые называются честно", () => {
    expect(sourceTitle({ via: "link", name: "channel-post", ref: "AbCd1234" })).toBe("ссылка channel-post · AbCd1234");
    expect(sourceTitle({ via: "code", name: "Стрим", ref: "11111111-1111-4111-8111-111111111111" })).toBe("код «Стрим»");
    expect(sourceTitle({ via: "link", name: null, ref: "AbCd1234" })).toBe("ссылка AbCd1234");
    expect(sourceTitle({ via: "code", name: null, ref: null })).toBe("код (кампании больше нет)");
  });
});
