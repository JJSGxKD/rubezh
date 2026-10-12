import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import {
  conversion,
  conversionState,
  createLink,
  fetchConversions,
  fetchLinks,
  freshRow,
  launchesLabel,
  resendConversion,
  retargetLink,
  SLUG,
  summaryLine,
  TARGET_TITLES,
  type Conversion,
  type ConversionSummary,
} from "../src/api/links";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

const LINK = {
  code: "Ab12Cd34Ef",
  url: "https://rubezh.example/r/Ab12Cd34Ef",
  platform: "telegram",
  campaign: "launch",
  source: "tg",
  medium: null,
  note: null,
  createdAt: "2026-09-25T10:00:00.000Z",
  network: null,
  registrationOn: "first_run",
  networkUrl: null,
  target: "app",
  directUrl: "https://t.me/rubezh_bot?startapp=l-Ab12Cd34Ef",
};

const counts = (patch: Partial<Record<"pending" | "sent" | "failed" | "skipped", number>> = {}) => ({ pending: 0, sent: 0, failed: 0, skipped: 0, ...patch });

const CONVERSION: Conversion = {
  conversionId: "0b6f2c1e-5d4a-4e8b-9c7d-1a2b3c4d5e6f",
  goal: 1,
  status: "pending",
  reason: null,
  attempts: 0,
  httpStatus: null,
  lastError: null,
  accountId: "8f7c1c1e-7f0a-4b8e-9d7e-1c2b3a4d5e6f",
  createdAt: "2026-10-02T10:00:00.000Z",
  sentAt: null,
  nextAttemptAt: "2026-10-02T10:00:00.000Z",
};

describe("ссылки кампаний", () => {
  it("список со статистикой и новая ссылка", async () => {
    const { fetch, calls } = fakeFetch(
      json(200, { data: { links: [{ ...LINK, clicks: 40, clicks30d: 12, launches: 10, directLaunches: 3, conversions: null }], postback: { adsgramToken: false } } }),
      json(200, { data: LINK }),
    );
    const api = new AdminApi(fetch);
    const list = await fetchLinks(api);
    expect(list.ok && list.data.links[0]?.launches).toBe(10);
    expect(list.ok && list.data.links[0]?.directLaunches).toBe(3);
    expect(list.ok && list.data.postback.adsgramToken).toBe(false);
    await createLink(api, { campaign: "launch", source: "tg" });
    expect(calls[1]?.url).toBe("/api/v1/admin/links");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ campaign: "launch", source: "tg" });
  });

  it("ссылка сети: сеть и режим регистрации уходят на сервер, адрес с метками приходит обратно", async () => {
    const adsgram = { ...LINK, network: "adsgram", registrationOn: "launch", networkUrl: `${LINK.url}?campaign={campaign_id}&record={record_data}` };
    const { fetch, calls } = fakeFetch(json(200, { data: adsgram }));
    const created = await createLink(new AdminApi(fetch), { campaign: "ag-1", source: "adsgram", network: "adsgram", registrationOn: "launch" });
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ network: "adsgram", registrationOn: "launch" });
    expect(created.ok && created.data.networkUrl).toContain("{record_data}");
  });

  it("сеть, о которой панель не знает, — обычная ссылка, а не сломанный список", async () => {
    const { fetch } = fakeFetch(
      json(200, { data: { links: [{ ...LINK, network: "future-net", clicks: 1, clicks30d: 1, launches: 0, directLaunches: 0, conversions: null }], postback: { adsgramToken: true } } }),
    );
    const list = await fetchLinks(new AdminApi(fetch));
    expect(list.ok && list.data.links[0]?.network).toBeNull();
  });

  it("цель и прямая ссылка: разбираются из ответа, у ссылки сети прямой ссылки нет", async () => {
    const network = { ...LINK, network: "adsgram", networkUrl: `${LINK.url}?record={record_data}`, target: "bot", directUrl: null };
    const { fetch } = fakeFetch(
      json(200, {
        data: {
          links: [
            { ...LINK, target: "landing", clicks: 5, clicks30d: 5, launches: 1, directLaunches: 2, conversions: null },
            { ...network, clicks: 9, clicks30d: 9, launches: 4, directLaunches: 0, conversions: { "1": counts(), "2": counts(), "3": counts() } },
          ],
          postback: { adsgramToken: true },
        },
      }),
    );
    const list = await fetchLinks(new AdminApi(fetch));
    expect(list.ok && list.data.links.map((link) => [link.target, link.directUrl])).toEqual([
      ["landing", "https://t.me/rubezh_bot?startapp=l-Ab12Cd34Ef"],
      ["bot", null],
    ]);
  });

  it("цель, о которой панель не знает, — Mini App, а не сломанный список", async () => {
    const { fetch } = fakeFetch(json(200, { data: { links: [{ ...LINK, target: "future-target", clicks: 1, clicks30d: 1, launches: 0, directLaunches: 0, conversions: null }], postback: { adsgramToken: true } } }));
    const list = await fetchLinks(new AdminApi(fetch));
    expect(list.ok && list.data.links[0]?.target).toBe("app");
  });

  it("новая ссылка уходит с целью; смена цели — PATCH с одним полем", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { ...LINK, target: "bot" } }), json(200, { data: { ...LINK, target: "landing" } }));
    const api = new AdminApi(fetch);
    await createLink(api, { campaign: "launch", target: "bot" });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ campaign: "launch", target: "bot" });
    const changed = await retargetLink(api, "Ab12Cd34Ef", "landing");
    expect(calls[1]?.url).toBe("/api/v1/admin/links/Ab12Cd34Ef");
    expect(calls[1]?.init.method).toBe("PATCH");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ target: "landing" });
    expect(changed.ok && changed.data.target).toBe("landing");
  });

  it("подписи целей и колонка «Запуски»: через переходник + прямых", () => {
    expect(TARGET_TITLES).toEqual({ app: "Mini App", bot: "Бот", landing: "Лендинг" });
    expect(launchesLabel({ launches: 10, directLaunches: 3 })).toBe("10 + 3");
    expect(launchesLabel({ launches: 0, directLaunches: 0 })).toBe("0 + 0");
  });

  it("журнал страницами и повтор отправки", async () => {
    const { fetch, calls } = fakeFetch(
      json(200, { data: { conversions: [CONVERSION], next: "2026-10-02T10:00:00.000Z_0b6f2c1e-5d4a-4e8b-9c7d-1a2b3c4d5e6f" } }),
      json(200, { data: CONVERSION }),
    );
    const api = new AdminApi(fetch);
    const page = await fetchConversions(api, "Ab12Cd34Ef", "2026-10-02T11:00:00.000Z_x");
    expect(calls[0]?.url).toBe("/api/v1/admin/links/Ab12Cd34Ef/conversions?before=2026-10-02T11%3A00%3A00.000Z_x");
    expect(page.ok && page.data.next).toContain("_0b6f2c1e");
    await resendConversion(api, "Ab12Cd34Ef", CONVERSION.conversionId);
    expect(calls[1]?.url).toBe(`/api/v1/admin/links/Ab12Cd34Ef/conversions/${CONVERSION.conversionId}/send`);
    expect(calls[1]?.init.method).toBe("POST");
  });

  it("заведённая ссылка — строкой списка с нулями: карточка открывается сразу", () => {
    expect(freshRow({ ...LINK, network: null, registrationOn: "first_run", networkUrl: null })).toMatchObject({ clicks: 0, launches: 0, directLaunches: 0, conversions: null });
    const row = freshRow({ ...LINK, network: "adsgram", registrationOn: "first_run", networkUrl: `${LINK.url}?record={record_data}`, directUrl: null });
    expect(row.conversions === null ? null : summaryLine(row.conversions)).toEqual({ registrations: 0, purchases: 0, failed: 0, waiting: 0 });
  });

  it("формат кампании и доля запусков", () => {
    expect(SLUG.test("launch-post_2")).toBe(true);
    expect(SLUG.test("Канал запуска")).toBe(false);
    expect(SLUG.test("-start")).toBe(false);
    expect(conversion({ clicks: 40, launches: 10 })).toBe(25);
    expect(conversion({ clicks: 0, launches: 0 })).toBeNull();
    expect(SECTIONS.find((section) => section.id === "links")?.permission).toBe("links.manage");
  });
});

describe("конверсии словами", () => {
  it("каждое состояние говорит, что случилось и можно ли отправить снова", () => {
    expect(conversionState(CONVERSION)).toMatchObject({ title: "В очереди", resendable: false });
    expect(conversionState({ ...CONVERSION, reason: "no_token" })).toMatchObject({ title: "Ждёт токен", tone: "warning", resendable: false });
    expect(conversionState({ ...CONVERSION, attempts: 2, lastError: "ответ 503" }).detail).toContain("ответ 503");
    expect(conversionState({ ...CONVERSION, status: "sent", sentAt: CONVERSION.createdAt, httpStatus: 200 })).toMatchObject({ title: "Ушла", tone: "success" });
    expect(conversionState({ ...CONVERSION, status: "failed", attempts: 8, lastError: "ответ 400: invalid record" })).toMatchObject({
      title: "Не ушла",
      resendable: true,
      detail: "ответ 400: invalid record — попыток: 8",
    });
    expect(conversionState({ ...CONVERSION, status: "skipped", reason: "team" })).toMatchObject({ resendable: true, detail: expect.stringContaining("аккаунт команды") });
    // Без меток сети повтор пропустился бы снова — кнопки нет.
    expect(conversionState({ ...CONVERSION, status: "skipped", reason: "no_macros" })).toMatchObject({ resendable: false, detail: expect.stringContaining("нет меток") });
    // Причина, которой панель не знает, показывается как есть, а не пропадает.
    expect(conversionState({ ...CONVERSION, status: "skipped", reason: "brand_new" }).detail).toBe("brand_new");
  });

  it("итог по ссылке: пропущенные — не конверсии сети, покупки — обе цели", () => {
    const summary: ConversionSummary = {
      "1": counts({ sent: 10, pending: 2, failed: 1, skipped: 4 }),
      "2": counts({ sent: 3 }),
      "3": counts({ sent: 1, failed: 2 }),
    };
    expect(summaryLine(summary)).toEqual({ registrations: 13, purchases: 6, failed: 3, waiting: 2 });
  });
});
