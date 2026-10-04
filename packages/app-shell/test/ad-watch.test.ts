import type { AdShowOutcome, AdShowRequest } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import type { CreativeHooks, CreativeResult, CreativeShow } from "../src/ads/ad-creative";
import { COMPLETED_REPORT_RETRIES_MS, requestOf, watchAd, type AdWatchDeps } from "../src/state/ad-watch";
import { adDeviceOf, createAdsApi, type AdOffer, type AdStep } from "../src/state/ads-api";
import type { ApiRequest, ApiResult } from "../src/state/api-request";

/**
 * Реклама за награду от нажатия до сессии хозяина места
 * (docs/35-stage4-plan.md WP12): у VIP — без ролика, досмотр — шагом
 * серверу, пока он не примет, отказ сети — одна попытка с другой сетью,
 * закрытие и долгое молчание — без второго ролика.
 */

const LATER = new Date(Date.UTC(2026, 9, 2, 12)).toISOString();

function offer(network: string, patch: Partial<Extract<AdOffer, { available: true }>> = {}): ApiResult<AdOffer> {
  return {
    ok: true,
    data: { available: true, sessionId: `session-${network}`, network, blockId: "123", format: "rewarded", keys: {}, success: "view", expiresAt: LATER, pass: null, ...patch },
  };
}

const CREATIVE = {
  ad: {
    id: "taddy-ad-1",
    title: "Рубеж держит",
    description: null,
    text: "Текст",
    image: "https://cdn.example/ad.png",
    icon: null,
    button: "Открыть",
    link: "https://t.me/example_bot?start=taddy",
    advertiser: "Taddy",
  },
  viewSec: 10,
};

interface Harness {
  deps: AdWatchDeps;
  offers: string[];
  shown: AdShowRequest[];
  creatives: CreativeShow[];
  opened: string[];
  reports: { sessionId: string; step: AdStep }[];
  events: { event: string; payload: Record<string, unknown> }[];
  sleeps: number[];
  muted: number;
}

/** Сервер отдаёт выдачи по очереди, сеть отвечает исходами по очереди. */
function harness(options: {
  offers: ApiResult<AdOffer>[];
  outcomes?: AdShowOutcome[];
  reports?: ApiResult<unknown>[];
  show?: false;
  /** что делает игрок в нашем блоке: жмёт на объявление и досматривает, закрывает раньше или блок не грузится */
  creative?: (hooks: CreativeHooks) => CreativeResult;
}): Harness {
  const offers = [...options.offers];
  const outcomes = [...(options.outcomes ?? [])];
  const reportAnswers = [...(options.reports ?? [])];
  let clock = 0;
  const h: Harness = {
    offers: [],
    shown: [],
    creatives: [],
    opened: [],
    reports: [],
    events: [],
    sleeps: [],
    muted: 0,
    deps: {
      ads: {
        offer: async (place, viewer) => (h.offers.push(`${place}:${String(viewer?.device)}`), offers.shift() ?? { ok: false, failure: "unavailable" }),
        report: async (sessionId, step) => (h.reports.push({ sessionId, step }), reportAnswers.shift() ?? { ok: true, data: { ok: true } }),
      },
      show:
        options.show === false
          ? undefined
          : async (request) => {
              h.shown.push(request);
              clock += 1_500;
              return outcomes.shift() ?? { kind: "failed", reason: "sdk_error" };
            },
      showCreative: async (show, hooks) => {
        h.creatives.push(show);
        clock += 10_000;
        return (options.creative ?? (() => ({ kind: "completed" as const })))(hooks);
      },
      openLink: (url) => void h.opened.push(url),
      viewer: { device: "android", language: "ru", premium: null },
      mute: async (task) => {
        h.muted++;
        return await task();
      },
      track: (event, payload) => h.events.push({ event, payload }),
      now: () => clock,
      sleep: async (ms) => void h.sleeps.push(ms),
    },
  };
  return h;
}

describe("реклама за награду", () => {
  it("VIP — сессия сразу, без ролика и без звука, который пришлось бы глушить", async () => {
    const h = harness({ offers: [offer("vip", { pass: "vip", blockId: null })] });
    expect(await watchAd("wheel_spin", h.deps)).toEqual({ kind: "watched", sessionId: "session-vip", source: "pass" });
    expect(h.shown).toHaveLength(0);
    expect(h.muted).toBe(0);
    expect(h.offers).toEqual(["wheel_spin:android"]);
  });

  it("досмотр — шаг серверу и сессия хозяину места; ролик — под заглушённым звуком, с флагом тестовых показов", async () => {
    const h = harness({ offers: [offer("adsgram", { debug: true })], outcomes: [{ kind: "completed" }] });
    expect(await watchAd("run_double", h.deps)).toEqual({ kind: "watched", sessionId: "session-adsgram", source: "ad" });
    expect(h.shown).toEqual([{ network: "adsgram", blockId: "123", format: "rewarded", keys: {}, debug: true }]);
    expect(h.muted).toBe(1);
    expect(h.reports).toEqual([{ sessionId: "session-adsgram", step: { outcome: "completed" } }]);
    expect(h.events).toEqual([{ event: "ad_shown", payload: { place: "run_double", network: "adsgram", ms: 1_500, completed: true } }]);
  });

  it("закрыл раньше — шаг «показан», награды нет, второго ролика тоже", async () => {
    const h = harness({ offers: [offer("adsgram"), offer("adsonar")], outcomes: [{ kind: "closed" }] });
    expect(await watchAd("wheel_spin", h.deps)).toEqual({ kind: "closed" });
    expect(h.offers).toHaveLength(1);
    expect(h.reports).toEqual([{ sessionId: "session-adsgram", step: { outcome: "shown" } }]);
    expect(h.events[0]).toMatchObject({ event: "ad_shown", payload: { completed: false } });
  });

  it("у сети нет рекламы — отказ в воронку и одна попытка с другой сетью", async () => {
    const h = harness({ offers: [offer("adsgram"), offer("adsonar")], outcomes: [{ kind: "failed", reason: "no_fill" }, { kind: "completed" }] });
    expect(await watchAd("wheel_spin", h.deps)).toEqual({ kind: "watched", sessionId: "session-adsonar", source: "ad" });
    expect(h.reports.map((report) => report.step)).toEqual([{ outcome: "failed", reason: "no_fill" }, { outcome: "completed" }]);
    expect(h.events.map((entry) => [entry.event, entry.payload["network"], entry.payload["attempt"]])).toEqual([
      ["ad_failed", "adsgram", 1],
      ["ad_shown", "adsonar", undefined],
    ]);
  });

  it("обе сети пусты — «рекламы нет»; скрипт не загрузился — «проверьте связь»; больше двух сетей не пробуем", async () => {
    const empty = harness({ offers: [offer("adsgram"), offer("adsonar"), offer("richads")], outcomes: [{ kind: "failed", reason: "no_fill" }, { kind: "failed", reason: "no_fill" }] });
    expect(await watchAd("wheel_spin", empty.deps)).toEqual({ kind: "no_ads" });
    expect(empty.offers).toHaveLength(2);

    const offline = harness({ offers: [offer("adsgram"), offer("adsonar")], outcomes: [{ kind: "failed", reason: "no_fill" }, { kind: "failed", reason: "load_failed" }] });
    expect(await watchAd("wheel_spin", offline.deps)).toEqual({ kind: "failed" });
  });

  it("после отказа сервер других сетей не нашёл — итог по отказу первой", async () => {
    const noMore = { ok: true, data: { available: false, reason: "no_fill", retryAt: null } } as const;
    expect(await watchAd("wheel_spin", harness({ offers: [offer("adsgram"), noMore], outcomes: [{ kind: "failed", reason: "no_fill" }] }).deps)).toEqual({ kind: "no_ads" });
    expect(await watchAd("wheel_spin", harness({ offers: [offer("adsgram"), noMore], outcomes: [{ kind: "failed", reason: "sdk_error" }] }).deps)).toEqual({ kind: "failed" });
    expect(await watchAd("wheel_spin", harness({ offers: [noMore] }).deps)).toEqual({ kind: "no_ads" });
  });

  it("SDK молчал до таймаута — второй ролик подряд не заказываем", async () => {
    const h = harness({ offers: [offer("adsgram"), offer("adsonar")], outcomes: [{ kind: "failed", reason: "timeout" }] });
    expect(await watchAd("wheel_spin", h.deps)).toEqual({ kind: "failed" });
    expect(h.offers).toHaveLength(1);
  });

  it("место на кулдауне — время, когда снова можно; сервер недоступен — «попробуйте ещё раз»", async () => {
    const cooldown = harness({ offers: [{ ok: true, data: { available: false, reason: "cooldown", retryAt: LATER } }] });
    expect(await watchAd("wheel_spin", cooldown.deps)).toEqual({ kind: "cooldown", retryAt: LATER });
    expect(await watchAd("wheel_spin", harness({ offers: [{ ok: false, failure: "offline" }] }).deps)).toEqual({ kind: "failed" });
  });

  it("награды за рекламу закрыты ограничением — так и говорим, а не «рекламы нет»; второй сети не ищем", async () => {
    const h = harness({ offers: [{ ok: true, data: { available: false, reason: "restricted", retryAt: null } }, offer("adsgram")] });
    expect(await watchAd("run_double", h.deps)).toEqual({ kind: "restricted" });
    expect(h.offers).toHaveLength(1);
  });

  it("досмотр не дошёл до сервера — повторяем, пока сеть моргает; отказ сервера повтором не лечится", async () => {
    const flaky = harness({ offers: [offer("adsgram")], outcomes: [{ kind: "completed" }], reports: [{ ok: false, failure: "offline" }, { ok: false, failure: "unavailable" }] });
    expect(await watchAd("wheel_spin", flaky.deps)).toMatchObject({ kind: "watched" });
    expect(flaky.sleeps).toEqual([...COMPLETED_REPORT_RETRIES_MS]);

    const lost = harness({ offers: [offer("adsgram")], outcomes: [{ kind: "completed" }], reports: [{ ok: false, failure: "offline" }, { ok: false, failure: "offline" }, { ok: false, failure: "offline" }] });
    expect(await watchAd("wheel_spin", lost.deps)).toEqual({ kind: "failed" });
    expect(lost.reports).toHaveLength(3);

    const expired = harness({ offers: [offer("adsgram")], outcomes: [{ kind: "completed" }], reports: [{ ok: false, failure: "rejected", code: "ad_session_closed" }] });
    expect(await watchAd("wheel_spin", expired.deps)).toEqual({ kind: "failed" });
    expect(expired.sleeps).toHaveLength(0);
  });

  it("площадка без рекламы сетей — «рекламы нет» сразу, а VIP всё равно получает награду", async () => {
    const h = harness({ offers: [offer("adsgram"), offer("adsonar")], show: false });
    expect(await watchAd("wheel_spin", h.deps)).toEqual({ kind: "no_ads" });
    expect(h.offers).toHaveLength(1);
    expect(h.reports).toEqual([{ sessionId: "session-adsgram", step: { outcome: "failed", reason: "unsupported" } }]);
    expect(await watchAd("wheel_spin", harness({ offers: [offer("vip", { pass: "vip" })], show: false }).deps)).toMatchObject({ kind: "watched", source: "pass" });
  });

  it("формат: старый сервер без него — видео; незнакомый от сервера новее — не показываем и пробуем другую сеть", async () => {
    const old = offer("adsgram", { format: undefined, keys: undefined, debug: undefined });
    expect(old.ok && old.data.available && requestOf(old.data)).toEqual({ network: "adsgram", blockId: "123", format: "rewarded", keys: {}, debug: false });
    const future = offer("adsgram", { format: "playable" });
    expect(future.ok && future.data.available && requestOf(future.data)).toBeNull();

    const h = harness({ offers: [future, offer("adsonar")], outcomes: [{ kind: "completed" }] });
    expect(await watchAd("wheel_spin", h.deps)).toMatchObject({ kind: "watched", sessionId: "session-adsonar" });
    expect(h.shown.map((request) => request.network)).toEqual(["adsonar"]);
    expect(h.reports[0]?.step).toEqual({ outcome: "failed", reason: "unsupported" });
  });
});

describe("объявление нашим блоком (Р78)", () => {
  it("креатив — нашим блоком, а не SDK: показ и клик — шагами серверу, клик — событием; досмотр — сессия к забору", async () => {
    const h = harness({
      offers: [offer("taddy", { blockId: null, creative: CREATIVE })],
      creative: (hooks) => {
        hooks.onShown();
        hooks.openLink?.(CREATIVE.ad.link);
        hooks.onClick();
        return { kind: "completed" };
      },
    });
    expect(await watchAd("wheel_spin", h.deps)).toEqual({ kind: "watched", sessionId: "session-taddy", source: "ad" });
    expect(h.shown).toEqual([]);
    expect(h.creatives).toEqual([{ ad: CREATIVE.ad, viewSec: 10, rewarded: true }]);
    expect(h.opened).toEqual([CREATIVE.ad.link]);
    expect(h.reports.map((report) => report.step)).toEqual([{ outcome: "shown" }, { outcome: "clicked" }, { outcome: "completed" }]);
    expect(h.events.map((entry) => entry.event)).toEqual(["ad_clicked", "ad_shown"]);
    expect(h.events[0]?.payload).toEqual({ place: "wheel_spin", network: "taddy" });
    expect(h.muted).toBe(1);
  });

  it("закрыл блок раньше — без награды; межстраничная — не за награду", async () => {
    const closed = harness({ offers: [offer("taddy", { blockId: null, creative: CREATIVE })], creative: () => ({ kind: "closed" }) });
    expect(await watchAd("wheel_spin", closed.deps)).toEqual({ kind: "closed" });

    const between = harness({ offers: [offer("taddy", { blockId: null, format: "interstitial", creative: CREATIVE })] });
    await watchAd("interstitial", between.deps);
    expect(between.creatives[0]?.rewarded).toBe(false);
  });

  it("картинка объявления не пришла — отказ, и выдача уходит к следующей сети", async () => {
    const h = harness({
      offers: [offer("taddy", { blockId: null, creative: CREATIVE }), offer("adsgram")],
      outcomes: [{ kind: "completed" }],
      creative: () => ({ kind: "failed", reason: "load_failed" }),
    });
    expect(await watchAd("wheel_spin", h.deps)).toEqual({ kind: "watched", sessionId: "session-adsgram", source: "ad" });
    expect(h.reports[0]).toEqual({ sessionId: "session-taddy", step: { outcome: "failed", reason: "load_failed" } });
  });

  it("площадка без SDK сетей креатив всё равно показывает — блок наш", async () => {
    const h = harness({ offers: [offer("taddy", { blockId: null, creative: CREATIVE })], show: false });
    expect(await watchAd("wheel_spin", h.deps)).toMatchObject({ kind: "watched" });
  });
});

describe("клиент рекламы", () => {
  function server(sent: { path: string; body: unknown }[], answer: unknown): ApiRequest {
    return async <T,>(path: string, schema: object, init?: { body?: unknown }): Promise<ApiResult<T>> => {
      sent.push({ path, body: init?.body });
      const { z } = await import("zod/mini");
      const parsed = z.object({ data: schema as never }).safeParse({ data: answer });
      return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
    };
  }

  it("выдача несёт только известные подсказки — устройство, язык, премиум; шаг показа — POST на сессию", async () => {
    const sent: { path: string; body: unknown }[] = [];
    const api = createAdsApi(server(sent, { ok: true }));
    await api.offer("wheel_spin", { device: "ios", language: "pt-br", premium: true });
    await api.offer("wheel_spin", { device: null, language: "русский", premium: null });
    await api.offer("wheel_spin");
    await api.report("AAAAAAAAAAAAAAAA", { outcome: "failed", reason: "no_fill" });
    expect(sent).toEqual([
      { path: "/api/v1/ads/sessions", body: { place: "wheel_spin", device: "ios", language: "pt-br", premium: true } },
      { path: "/api/v1/ads/sessions", body: { place: "wheel_spin" } },
      { path: "/api/v1/ads/sessions", body: { place: "wheel_spin" } },
      { path: "/api/v1/ads/sessions/AAAAAAAAAAAAAAAA/result", body: { outcome: "failed", reason: "no_fill" } },
    ]);
  });

  it("креатив в выдаче разбирается схемой; сервер без поля — показ SDK", async () => {
    const sent: { path: string; body: unknown }[] = [];
    const base = { available: true, sessionId: "s", network: "taddy", blockId: null, format: "rewarded", keys: {}, success: "view", expiresAt: LATER, pass: null };
    const withCreative = await createAdsApi(server(sent, { ...base, creative: CREATIVE })).offer("wheel_spin");
    expect(withCreative.ok && withCreative.data.available ? withCreative.data.creative : undefined).toEqual(CREATIVE);
    expect((await createAdsApi(server(sent, base)).offer("wheel_spin")).ok).toBe(true);
    // Срок досмотра вне разумного — ответ не принимается, а не блок на час.
    expect((await createAdsApi(server(sent, { ...base, creative: { ...CREATIVE, viewSec: 3600 } })).offer("wheel_spin")).ok).toBe(false);

  });

  it("устройство — по клиенту Telegram: веб-версия на телефоне — web; незнакомый клиент — не знаем", () => {
    expect(adDeviceOf("android")).toBe("android");
    expect(adDeviceOf("android_x")).toBe("android");
    expect(adDeviceOf("ios")).toBe("ios");
    expect(adDeviceOf("tdesktop")).toBe("desktop");
    expect(adDeviceOf("macos")).toBe("desktop");
    expect(adDeviceOf("weba")).toBe("web");
    expect(adDeviceOf("unknown")).toBeNull();
    expect(adDeviceOf(null)).toBeNull();
  });
});
