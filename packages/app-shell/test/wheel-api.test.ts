import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { createAdsApi, passSession, type AdOffer, type AdsApi } from "../src/state/ads-api";
import { WHEEL_AD_COOLDOWN, WHEEL_AD_NEEDS_VIDEO, adSpinState, createWheelApi, spinWithPass, type WheelApi } from "../src/state/wheel-api";

// Клиент колеса (docs/35-stage4-plan.md WP13): сектора и крутка — с сервера,
// схемой; в теле крутки — только чем крутят, что выпало, решает сервер. У VIP
// крутка за рекламу — без ролика (§3.6): сессия места сразу идёт в крутку.

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

function server(sent: Sent[], answer: unknown): ApiRequest {
  return async <T,>(path: string, schema: object, init?: { method?: string; body?: unknown }): Promise<ApiResult<T>> => {
    sent.push({ method: init?.method ?? "GET", path, body: init?.body });
    const { z } = await import("zod/mini");
    const parsed = z.object({ data: schema as never }).safeParse({ data: answer });
    return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
  };
}

const VIEW = {
  sectors: [
    { resource: "coins", amount: 50, odds: 0.24 },
    { resource: "shard_common", amount: 3, odds: 0.16 },
    { resource: "coins", amount: 1000, odds: 0.02 },
    { resource: "boost_fury", amount: 1, odds: 0.58 },
  ],
  free: true,
};

describe("клиент колеса", () => {
  it("колесо — GET, крутка — POST с видом крутки; незнакомый ресурс сервера новее клиента принимается", async () => {
    const sent: Sent[] = [];
    const view = await createWheelApi(server(sent, VIEW)).view();
    expect(view.ok && view.data.sectors.map((sector) => sector.resource)).toEqual(["coins", "shard_common", "coins", "boost_fury"]);

    const spin = await createWheelApi(server(sent, { sector: 2, resource: "coins", amount: 1000, credited: 1000, view: { ...VIEW, free: false } })).spin();
    expect(spin.ok && spin.data).toMatchObject({ sector: 2, credited: 1000, view: { free: false } });
    expect(sent).toEqual([
      { method: "GET", path: "/api/v1/wheel", body: undefined },
      { method: "POST", path: "/api/v1/wheel/spin", body: { source: "free" } },
    ]);
  });

  it("ответ не по схеме — отказ, а не колесо без секторов", async () => {
    const broken = await createWheelApi(server([], { sectors: [{ resource: "coins" }], free: true })).view();
    expect(broken.ok).toBe(false);
  });


  it("крутка за рекламу — тем же POST с сессией показа; готовность места — в виде колеса, старый сервер без неё — «скоро»", async () => {
    const sent: Sent[] = [];
    const spin = { sector: 0, resource: "coins", amount: 50, credited: 50, view: VIEW };
    await createWheelApi(server(sent, spin)).spinAd("AAAAAAAAAAAAAAAA");
    expect(sent).toEqual([{ method: "POST", path: "/api/v1/wheel/spin", body: { source: "ad", sessionId: "AAAAAAAAAAAAAAAA" } }]);

    const view = await createWheelApi(server([], { ...VIEW, ad: { available: true, readyAt: null, pass: "vip" } })).view();
    expect(view.ok && view.data.ad).toEqual({ available: true, readyAt: null, pass: "vip" });
    expect(adSpinState({}, 0)).toEqual({ kind: "soon" });
  });
});

describe("крутка VIP без ролика", () => {
  const NOW = Date.UTC(2026, 9, 1, 9);
  const later = new Date(NOW + 60_000).toISOString();

  it("кнопка: без пропуска — «скоро», у VIP — крутка или отсчёт до конца кулдауна", () => {
    expect(adSpinState({ ad: { available: true, readyAt: null, pass: null } }, NOW)).toEqual({ kind: "soon" });
    expect(adSpinState({ ad: { available: true, readyAt: null } }, NOW)).toEqual({ kind: "soon" });
    expect(adSpinState({ ad: { available: true, readyAt: null, pass: "vip" } }, NOW)).toEqual({ kind: "ready" });
    expect(adSpinState({ ad: { available: true, readyAt: later, pass: "vip" } }, NOW)).toEqual({ kind: "wait", untilMs: NOW + 60_000 });
    expect(adSpinState({ ad: { available: true, readyAt: later, pass: "vip" } }, NOW + 60_000)).toEqual({ kind: "ready" });
  });

  function fakeAds(answer: Awaited<ReturnType<AdsApi["offer"]>>): AdsApi & { places: string[] } {
    const places: string[] = [];
    return { places, offer: async (place) => (places.push(place), answer) };
  }

  function fakeWheel(): Pick<WheelApi, "spinAd"> & { sessions: string[] } {
    const sessions: string[] = [];
    return { sessions, spinAd: async (sessionId) => (sessions.push(sessionId), { ok: true, data: { sector: 1, resource: "coins", amount: 70, credited: 70, view: VIEW } }) };
  }

  const PASS: AdOffer = { available: true, sessionId: "AAAAAAAAAAAAAAAA", network: "vip", blockId: null, success: "view", expiresAt: later, pass: "vip" };

  it("пропуск — сессия места сразу идёт в крутку колеса", async () => {
    const ads = fakeAds({ ok: true, data: PASS });
    const wheel = fakeWheel();
    expect(await spinWithPass(ads, wheel)).toMatchObject({ ok: true, data: { sector: 1 } });
    expect(ads.places).toEqual(["wheel_spin"]);
    expect(wheel.sessions).toEqual(["AAAAAAAAAAAAAAAA"]);
  });

  it("кулдаун, нужен ролик или отказ сети — без крутки и с кодом, по которому экран перечитывается", async () => {
    const wheel = fakeWheel();
    expect(await spinWithPass(fakeAds({ ok: true, data: { available: false, reason: "cooldown", retryAt: later } }), wheel)).toEqual({ ok: false, failure: "rejected", code: WHEEL_AD_COOLDOWN });
    expect(await spinWithPass(fakeAds({ ok: true, data: { available: false, reason: "no_fill", retryAt: null } }), wheel)).toMatchObject({ code: WHEEL_AD_NEEDS_VIDEO });
    expect(await spinWithPass(fakeAds({ ok: true, data: { ...PASS, network: "adsgram", blockId: "123", pass: null } }), wheel)).toMatchObject({ code: WHEEL_AD_NEEDS_VIDEO });
    expect(await spinWithPass(fakeAds({ ok: false, failure: "offline" }), wheel)).toEqual({ ok: false, failure: "offline" });
    expect(wheel.sessions).toHaveLength(0);
  });

  it("выдача показа — POST с местом; ответ без пропуска от старого сервера — показ, а не пропуск", async () => {
    const sent: Sent[] = [];
    const offer = await createAdsApi(server(sent, { ...PASS, pass: undefined, network: "adsgram", blockId: "123" })).offer("wheel_spin");
    expect(sent).toEqual([{ method: "POST", path: "/api/v1/ads/sessions", body: { place: "wheel_spin" } }]);
    expect(offer.ok && passSession(offer.data)).toBeNull();
    expect(passSession(PASS)).toBe("AAAAAAAAAAAAAAAA");
    expect(passSession({ available: false, reason: "pass", retryAt: null })).toBeNull();
  });

  it("показ несёт формат места и ключи сети — их ждёт SDK; ключ не строкой — ответ не по схеме", async () => {
    const richads = { ...PASS, pass: null, network: "richads", blockId: null, format: "rewarded", keys: { pubId: "792361", appId: "1396" } };
    const offer = await createAdsApi(server([], richads)).offer("wheel_spin");
    expect(offer.ok && offer.data.available && offer.data.keys).toEqual({ pubId: "792361", appId: "1396" });
    expect((await createAdsApi(server([], { ...richads, keys: { pubId: 792361 } })).offer("wheel_spin")).ok).toBe(false);
  });
});
