import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import type { AdWatchResult } from "../src/state/ad-watch";
import { createAdsApi, passSession, type AdOffer } from "../src/state/ads-api";
import { WHEEL_AD_CLOSED, WHEEL_AD_COOLDOWN, WHEEL_AD_FAILED, WHEEL_NO_ADS, adSpinState, createWheelApi, spinForAd, type WheelApi } from "../src/state/wheel-api";

// Клиент колеса (docs/35-stage4-plan.md WP13): сектора и крутка — с сервера,
// схемой; в теле крутки — только чем крутят, что выпало, решает сервер.
// Крутка за рекламу — по досмотренной сессии показа, у VIP — без ролика
// (§3.6): сессия места сразу идёт в крутку.

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


  it("крутка за рекламу — тем же POST с сессией показа; готовность места — в виде колеса, старый сервер без неё — кнопки нет", async () => {
    const sent: Sent[] = [];
    const spin = { sector: 0, resource: "coins", amount: 50, credited: 50, view: VIEW };
    await createWheelApi(server(sent, spin)).spinAd("AAAAAAAAAAAAAAAA");
    expect(sent).toEqual([{ method: "POST", path: "/api/v1/wheel/spin", body: { source: "ad", sessionId: "AAAAAAAAAAAAAAAA" } }]);

    const view = await createWheelApi(server([], { ...VIEW, ad: { available: true, readyAt: null, pass: "vip" } })).view();
    expect(view.ok && view.data.ad).toEqual({ available: true, readyAt: null, pass: "vip" });
    expect(adSpinState({}, 0, true)).toEqual({ kind: "hidden" });
  });
});

describe("крутка за рекламу", () => {
  const NOW = Date.UTC(2026, 9, 1, 9);
  const later = new Date(NOW + 60_000).toISOString();

  it("кнопка: ролик — где площадка его покажет, VIP — везде; кулдаун — отсчётом; рекламы для площадки нет — кнопки нет", () => {
    expect(adSpinState({ ad: { available: true, readyAt: null, pass: null } }, NOW, true)).toEqual({ kind: "ready", pass: false });
    expect(adSpinState({ ad: { available: true, readyAt: null } }, NOW, true)).toEqual({ kind: "ready", pass: false });
    expect(adSpinState({ ad: { available: true, readyAt: null, pass: null } }, NOW, false)).toEqual({ kind: "hidden" });
    expect(adSpinState({ ad: { available: true, readyAt: null, pass: "vip" } }, NOW, false)).toEqual({ kind: "ready", pass: true });
    expect(adSpinState({ ad: { available: true, readyAt: later, pass: null } }, NOW, true)).toEqual({ kind: "wait", untilMs: NOW + 60_000, pass: false });
    expect(adSpinState({ ad: { available: true, readyAt: later, pass: "vip" } }, NOW + 60_000, true)).toEqual({ kind: "ready", pass: true });
    expect(adSpinState({ ad: { available: false, readyAt: null, pass: null } }, NOW, true)).toEqual({ kind: "hidden" });
  });

  function fakeWheel(answer: Awaited<ReturnType<WheelApi["spinAd"]>> = { ok: true, data: { sector: 1, resource: "coins", amount: 70, credited: 70, view: VIEW } }): Pick<WheelApi, "spinAd"> & { sessions: string[] } {
    const sessions: string[] = [];
    return { sessions, spinAd: async (sessionId) => (sessions.push(sessionId), answer) };
  }

  const watched = (result: AdWatchResult) => async () => result;

  it("досмотр или VIP — сессия сразу в крутку, и награда отмечается источником", async () => {
    for (const source of ["ad", "pass"] as const) {
      const wheel = fakeWheel();
      const rewarded: string[] = [];
      expect(await spinForAd(watched({ kind: "watched", sessionId: "AAAAAAAAAAAAAAAA", source }), wheel, (via) => rewarded.push(via))).toMatchObject({ ok: true, data: { sector: 1 } });
      expect(wheel.sessions).toEqual(["AAAAAAAAAAAAAAAA"]);
      expect(rewarded).toEqual([source]);
    }
  });

  it("без досмотра — без крутки, с кодом, по которому экран скажет, что случилось", async () => {
    const wheel = fakeWheel();
    const never = () => expect.unreachable("награды без крутки не бывает");
    expect(await spinForAd(watched({ kind: "cooldown", retryAt: later }), wheel, never)).toEqual({ ok: false, failure: "rejected", code: WHEEL_AD_COOLDOWN });
    expect(await spinForAd(watched({ kind: "closed" }), wheel, never)).toMatchObject({ code: WHEEL_AD_CLOSED });
    expect(await spinForAd(watched({ kind: "no_ads" }), wheel, never)).toMatchObject({ code: WHEEL_NO_ADS });
    expect(await spinForAd(watched({ kind: "failed" }), wheel, never)).toMatchObject({ code: WHEEL_AD_FAILED });
    // Ограничение — тем же отказом, что у сервера: экран покажет плашку, как везде.
    expect(await spinForAd(watched({ kind: "restricted" }), wheel, never)).toEqual({ ok: false, failure: "disabled", code: "account_restricted" });
    expect(wheel.sessions).toHaveLength(0);
  });

  it("крутка по сессии не прошла — отказ сервера как есть, награда не отмечается", async () => {
    const wheel = fakeWheel({ ok: false, failure: "rejected", code: WHEEL_AD_COOLDOWN });
    const rewarded: string[] = [];
    expect(await spinForAd(watched({ kind: "watched", sessionId: "AAAAAAAAAAAAAAAA", source: "ad" }), wheel, (via) => rewarded.push(via))).toMatchObject({ code: WHEEL_AD_COOLDOWN });
    expect(rewarded).toHaveLength(0);
  });

  const PASS: AdOffer = { available: true, sessionId: "AAAAAAAAAAAAAAAA", network: "vip", blockId: null, success: "view", expiresAt: later, pass: "vip" };

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
