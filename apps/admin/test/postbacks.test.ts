import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import {
  DESTINATION_TITLES,
  POSTBACK_EXAMPLE,
  conversionSchema,
  conversionState,
  destinationTitle,
  linkSchema,
  postbackEventsLine,
  postbackState,
  setLinkPostback,
  type Conversion,
} from "../src/api/links";
import { fetchPartner, partnerFormOf, setPartnerPostback, type Partner } from "../src/api/partners";
import { formatDateTime } from "../src/format";
import { fakeFetch, json } from "./helpers";

// Постбэки в s2s-сети и партнёру в панели (tasks/T-0070, Р86, Р96): подписи назначений и причин
// пропуска в журнале, строка «Отправляем по кликам с …», пример адреса и запросы на сохранение.

const ADDRESS = "https://track.example.com/pb?cid={click_id}&e={event}";

const CONVERSION: Conversion = {
  conversionId: "0b6f2c1e-5d4a-4e8b-9c7d-1a2b3c4d5e6f",
  goal: 1,
  destination: "s2s",
  status: "pending",
  reason: null,
  attempts: 0,
  httpStatus: null,
  lastError: null,
  accountId: "8f7c1c1e-7f0a-4b8e-9d7e-1c2b3a4d5e6f",
  createdAt: "2026-11-08T10:00:00.000Z",
  sentAt: null,
  nextAttemptAt: "2026-11-08T10:00:00.000Z",
};

const LINK = {
  code: "Ab12Cd34Ef",
  url: "https://rubezh.example/r/Ab12Cd34Ef",
  platform: "telegram",
  campaign: "launch",
  source: "tg",
  medium: null,
  note: null,
  createdAt: "2026-11-01T10:00:00.000Z",
  network: null,
  registrationOn: "first_run",
  networkUrl: null,
  target: "app",
  directUrl: null,
  partner: null,
};

const PARTNER: Partner = {
  partnerId: "0c4a5c1e-6a57-4d43-8a2a-0f3f6d0a9b10",
  name: "Канал",
  contact: "@channel",
  note: null,
  createdAt: "2026-10-02T09:00:00.000Z",
  updatedAt: "2026-10-02T09:00:00.000Z",
  telegramId: null,
  status: "active",
  country: "KZ",
  payoutCurrency: "USD",
  payoutMethod: null,
  sharePercent: "12.50",
  postbackUrl: null,
  postbackSince: null,
  postbackEvents: ["registration"],
  stats: { codes: 0, activeCodes: 0, redeemed: 0, bound: 0, played: 0, payers: 0, stars: 0 },
};

describe("назначения в журнале", () => {
  it("подписи: AdsGram, «Адрес сети», «Партнёр»; незнакомое показывается как есть", () => {
    expect(DESTINATION_TITLES).toEqual({ adsgram: "AdsGram", s2s: "Адрес сети", partner: "Партнёр" });
    expect(destinationTitle("adsgram")).toBe("AdsGram");
    expect(destinationTitle("s2s")).toBe("Адрес сети");
    expect(destinationTitle("partner")).toBe("Партнёр");
    expect(destinationTitle("future")).toBe("future");
  });

  it("строка журнала несёт назначение; старый сервер без него — AdsGram, строка не ломается", () => {
    const row = { ...CONVERSION };
    expect(conversionSchema.parse(row).destination).toBe("s2s");
    const { destination, ...legacy } = row;
    void destination;
    expect(conversionSchema.parse(legacy).destination).toBe("adsgram");
    expect(conversionSchema.parse({ ...row, destination: "future" }).destination).toBe("future");
  });

  it("причины пропуска: адрес снят и в ссылке не было click_id; их повтором не лечить", () => {
    const noAddress = conversionState({ ...CONVERSION, status: "skipped", reason: "no_address" });
    expect(noAddress).toMatchObject({ title: "Пропущена", detail: "адрес постбэка снят", resendable: false });
    const noClickId = conversionState({ ...CONVERSION, status: "skipped", reason: "no_click_id" });
    expect(noClickId).toMatchObject({ title: "Пропущена", detail: "в ссылке не было click_id", resendable: false });
    // Прежние причины на месте.
    expect(conversionState({ ...CONVERSION, status: "skipped", reason: "team" }).resendable).toBe(true);
    expect(conversionState({ ...CONVERSION, status: "skipped", reason: "no_macros" }).detail).toContain("меток сети");
  });
});

describe("состояние адреса постбэка", () => {
  it("адрес задан — с какого времени идут клики, прошлое не досылается", () => {
    const since = "2026-11-08T09:30:00.000Z";
    expect(postbackState({ postbackUrl: ADDRESS, postbackSince: since })).toBe(`Отправляем по кликам с ${formatDateTime(since)}. События по более ранним кликам не отправляются.`);
  });

  it("адреса нет — ничего не отправляем", () => {
    expect(postbackState({ postbackUrl: null, postbackSince: null })).toBe("Адрес не задан — ничего не отправляем.");
    // Адрес без момента не бывает (CHECK в базе), но панель не должна показывать «с null».
    expect(postbackState({ postbackUrl: ADDRESS, postbackSince: null })).toBe("Адрес не задан — ничего не отправляем.");
  });

  it("«Получает»: события словами", () => {
    expect(postbackEventsLine(["registration"])).toBe("Получает: регистрация.");
    expect(postbackEventsLine(["registration", "purchase_first", "purchase_repeat", "d1_return"])).toBe(
      "Получает: регистрация, первая покупка, повторная покупка, возврат на следующий день.",
    );
    expect(postbackEventsLine([])).toBe("Получает: ничего.");
    expect(postbackEventsLine(["future_event"])).toBe("Получает: future_event.");
  });

  it("пример подставляется ровно как в спецификации", () => {
    expect(POSTBACK_EXAMPLE).toBe("https://example.com/postback?click_id={click_id}&event={event}&event_id={event_id}&amount={amount}&currency={currency}&sub1={sub1}");
  });
});

describe("ссылка и партнёр: поля постбэка в ответе", () => {
  it("ссылка: адрес, момент и события; старый сервер без полей — адреса нет, одна регистрация", () => {
    const withPostback = linkSchema.parse({ ...LINK, postbackUrl: ADDRESS, postbackSince: "2026-11-08T09:30:00.000Z", postbackEvents: ["registration", "purchase_first"] });
    expect(withPostback).toMatchObject({ postbackUrl: ADDRESS, postbackSince: "2026-11-08T09:30:00.000Z", postbackEvents: ["registration", "purchase_first"] });
    expect(linkSchema.parse(LINK)).toMatchObject({ postbackUrl: null, postbackSince: null, postbackEvents: ["registration"] });
  });

  it("партнёр: то же", async () => {
    const wire = { ...PARTNER, postbackUrl: ADDRESS, postbackSince: "2026-11-08T09:30:00.000Z" };
    const { fetch } = fakeFetch(json(200, { data: { partner: wire, daily: [], codes: [], links: [], linkBound: 0, rules: { bindWindowDays: 7 } } }));
    const detail = await fetchPartner(new AdminApi(fetch), PARTNER.partnerId);
    expect(detail.ok && detail.data.partner).toMatchObject({ postbackUrl: ADDRESS, postbackSince: "2026-11-08T09:30:00.000Z", postbackEvents: ["registration"] });

    const { postbackUrl, postbackSince, postbackEvents, ...legacy } = PARTNER;
    void postbackUrl;
    void postbackSince;
    void postbackEvents;
    const old = fakeFetch(json(200, { data: { partner: legacy, daily: [], codes: [], links: [], linkBound: 0, rules: { bindWindowDays: 7 } } }));
    const fallback = await fetchPartner(new AdminApi(old.fetch), PARTNER.partnerId);
    expect(fallback.ok && fallback.data.partner).toMatchObject({ postbackUrl: null, postbackSince: null, postbackEvents: ["registration"] });
  });
});

describe("сохранение адреса", () => {
  it("ссылка: PATCH /links/<код> с postbackUrl; пустой и из пробелов — null, адрес обрезается", async () => {
    const { fetch, calls } = fakeFetch(
      json(200, { data: { ...LINK, postbackUrl: ADDRESS, postbackSince: "2026-11-08T09:30:00.000Z" } }),
      json(200, { data: LINK }),
      json(200, { data: LINK }),
    );
    const api = new AdminApi(fetch);
    const saved = await setLinkPostback(api, "Ab12Cd34Ef", `  ${ADDRESS}  `);
    expect(saved.ok && saved.data.postbackUrl).toBe(ADDRESS);
    await setLinkPostback(api, "Ab12Cd34Ef", "   ");
    await setLinkPostback(api, "Ab12Cd34Ef", null);
    expect(calls.map((call) => [call.init.method, call.url.replace(/^.*\/api\/v1\/admin/, ""), JSON.parse(String(call.init.body))])).toEqual([
      ["PATCH", "/links/Ab12Cd34Ef", { postbackUrl: ADDRESS }],
      ["PATCH", "/links/Ab12Cd34Ef", { postbackUrl: null }],
      ["PATCH", "/links/Ab12Cd34Ef", { postbackUrl: null }],
    ]);
  });

  it("ошибка сервера доходит как есть — введённое остаётся в поле", async () => {
    const { fetch } = fakeFetch(json(400, { error: { code: "validation", message: "Адрес должен начинаться с https://" } }));
    const result = await setLinkPostback(new AdminApi(fetch), "Ab12Cd34Ef", "http://track.example.com/pb");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toBe("Адрес должен начинаться с https://");
  });

  it("партнёр: POST /partners/<id> со всеми полями карточки и postbackUrl — остальные условия не стираются", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { ...PARTNER, postbackUrl: ADDRESS, postbackSince: "2026-11-08T09:30:00.000Z" } }));
    const saved = await setPartnerPostback(new AdminApi(fetch), PARTNER, ADDRESS);
    expect(saved.ok && saved.data.postbackUrl).toBe(ADDRESS);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.url).toContain(`/partners/${PARTNER.partnerId}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      name: "Канал",
      contact: "@channel",
      note: null,
      telegramId: null,
      country: "KZ",
      payoutCurrency: "USD",
      payoutMethod: null,
      sharePercent: "12.50",
      postbackUrl: ADDRESS,
    });
    // Форма карточки адрес не знает: правка условий его не трогает.
    expect(partnerFormOf(PARTNER)).not.toHaveProperty("postbackUrl");
  });

  it("партнёр: пустой адрес — null", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: PARTNER }));
    await setPartnerPostback(new AdminApi(fetch), PARTNER, "  ");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ postbackUrl: null });
  });
});
