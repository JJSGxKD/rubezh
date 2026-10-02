import type { AdShowRequest } from "@bh/shared-types";
import { describe, expect, it, vi } from "vitest";
import { createAdShower } from "../src/ads/ad-shower";
import { createAudience } from "../src/ads/audience";
import { ADSGRAM_SCRIPT, ADSONAR_SCRIPT, RICHADS_NO_FILL_MS, RICHADS_SCRIPT, TADDY_SCRIPT, type AdGlobals, type AdsgramController, type AdsgramResult, type SonarShowParams } from "../src/ads/networks";
import { createScriptLoader, type ScriptHost } from "../src/ads/script-loader";

/**
 * Показ рекламы сетей на поддельных SDK: скрипт — при первом показе и один
 * раз, исход SDK — в один из трёх исходов порта, «нет рекламы» отличается
 * от «закрыл», два показа разом невозможны, замолчавший SDK не вешает показ.
 */

const request = (patch: Partial<AdShowRequest>): AdShowRequest => ({ network: "adsgram", blockId: "123", format: "rewarded", keys: {}, ...patch });
const PUB_ID = "14cbeb980853dd416003462ca4db7c12";

/** Загрузчик, который «загружает» скрипт, кладя объект SDK в поддельное окно. */
function fakeLoader(globals: AdGlobals, install: Record<string, (globals: AdGlobals) => void>) {
  const loaded: { src: string; attributes: Readonly<Record<string, string>> }[] = [];
  return {
    loaded,
    loader: {
      async load(src: string, attributes: Readonly<Record<string, string>> = {}) {
        loaded.push({ src, attributes });
        const base = src.split("?")[0] ?? src;
        const setup = install[base];
        if (setup === undefined) throw new Error("нет такого скрипта");
        setup(globals);
      },
    },
  };
}

function adsgramController(show: () => Promise<AdsgramResult>): AdsgramController & { fire(event: string): void } {
  const handlers = new Map<string, Set<() => void>>();
  return {
    show,
    addEventListener: (event, handler) => void handlers.set(event, (handlers.get(event) ?? new Set()).add(handler)),
    removeEventListener: (event, handler) => void handlers.get(event)?.delete(handler),
    destroy: () => undefined,
    fire: (event) => handlers.get(event)?.forEach((handler) => handler()),
  };
}

describe("показ рекламы сетей", () => {
  it("AdsGram: скрипт и init — однажды на блок; досмотр, пропуск, нет рекламы, ошибка", async () => {
    const globals: AdGlobals = {};
    let next: () => Promise<AdsgramResult> = async () => ({ done: true, description: "", state: "destroy", error: false });
    const controller = adsgramController(() => next());
    const init = vi.fn(() => controller);
    const { loader, loaded } = fakeLoader(globals, { [ADSGRAM_SCRIPT]: (g) => void (g.Adsgram = { init }) });
    const show = createAdShower({ globals: () => globals, loader });

    expect(await show(request({}))).toEqual({ kind: "completed" });
    next = () => Promise.reject({ done: false, description: "skipped", state: "playing", error: false });
    expect(await show(request({}))).toEqual({ kind: "closed" });
    next = () => {
      controller.fire("onBannerNotFound");
      return Promise.reject({ done: false, description: "no banner", state: "load", error: true });
    };
    expect(await show(request({}))).toEqual({ kind: "failed", reason: "no_fill" });
    next = () => Promise.reject({ done: false, description: "boom", state: "render", error: true });
    expect(await show(request({}))).toEqual({ kind: "failed", reason: "sdk_error" });

    expect(loaded).toHaveLength(1);
    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith({ blockId: "123", debug: false });
    // Задание AdsGram — веб-компонент на экране заданий, а не показ.
    expect(await show(request({ format: "task", blockId: "task-1" }))).toEqual({ kind: "failed", reason: "unsupported" });
  });

  it("AdSonar: appId — в адресе скрипта; у видео исход событиями, у межстраничной — завершением", async () => {
    const globals: AdGlobals = {};
    let react: (params: SonarShowParams) => Promise<{ status: string } | undefined> = async (params) => {
      params.onReward?.();
      params.onClose?.();
      return { status: "showing" };
    };
    const calls: SonarShowParams[] = [];
    const { loader, loaded } = fakeLoader(globals, {
      [ADSONAR_SCRIPT]: (g) =>
        void (g.Sonar = {
          show: async (params) => {
            calls.push(params);
            return await react(params);
          },
        }),
    });
    const show = createAdShower({ globals: () => globals, loader });
    const sonar = request({ network: "adsonar", blockId: "rewarded_wheel", keys: { appId: "app_133d2148" }, debug: true });

    expect(await show(sonar)).toEqual({ kind: "completed" });
    expect(loaded[0]?.src).toBe(`${ADSONAR_SCRIPT}?appId=app_133d2148&isDebug=true`);
    expect(calls[0]).toMatchObject({ adUnit: "rewarded_wheel", loader: true });
    react = async (params) => {
      params.onClose?.();
      return { status: "hidden" };
    };
    expect(await show(sonar)).toEqual({ kind: "closed" });
    react = async () => ({ status: "error" });
    expect(await show(sonar)).toEqual({ kind: "failed", reason: "no_fill" });

    react = async () => ({ status: "hidden" });
    expect(await show({ ...sonar, format: "interstitial" })).toEqual({ kind: "completed" });
    expect(await show({ ...sonar, keys: {} })).toEqual({ kind: "failed", reason: "misconfigured" });
  });

  it("RichAds: initialize однажды с ключами; быстрый отказ — нет рекламы, поздний — закрыл", async () => {
    const globals: AdGlobals = {};
    let clock = 0;
    const initialize = vi.fn();
    let video: () => Promise<unknown> = async () => true;
    class Controller {
      initialize = initialize;
      triggerInterstitialVideo = () => video();
      triggerInterstitialBanner = async () => true;
    }
    const { loader } = fakeLoader(globals, { [RICHADS_SCRIPT]: (g) => void (g.TelegramAdsController = Controller) });
    const show = createAdShower({ globals: () => globals, loader, now: () => clock });
    const rich = request({ network: "richads", blockId: null, keys: { pubId: "792361", appId: "1396" } });

    expect(await show(rich)).toEqual({ kind: "completed" });
    video = async () => {
      clock += RICHADS_NO_FILL_MS - 1;
      throw new Error("no ads");
    };
    expect(await show(rich)).toEqual({ kind: "failed", reason: "no_fill" });
    video = async () => {
      clock += RICHADS_NO_FILL_MS + 10_000;
      throw new Error("closed");
    };
    expect(await show(rich)).toEqual({ kind: "closed" });
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledWith({ pubId: "792361", appId: "1396", debug: false });
    expect(await show({ ...rich, keys: { pubId: "792361" } })).toEqual({ kind: "failed", reason: "misconfigured" });
  });

  it("Taddy SDK не показывает: её креатив рисует оболочка — показ через адаптер не поддержан", async () => {
    const loaded: string[] = [];
    const show = createAdShower({ globals: () => ({}), loader: { load: async (src) => void loaded.push(src) } });
    expect(await show(request({ network: "taddy", blockId: null, keys: { pubId: PUB_ID } }))).toEqual({ kind: "failed", reason: "unsupported" });
    expect(loaded).toEqual([]);
  });

  it("два показа разом невозможны, замолчавший SDK — таймаут, незнакомая сеть и незагруженный скрипт — свои отказы", async () => {
    vi.useFakeTimers();
    try {
      const globals: AdGlobals = { Adsgram: { init: () => adsgramController(() => new Promise<AdsgramResult>(() => undefined)) } };
      const show = createAdShower({ globals: () => globals, loader: { load: async () => undefined }, timeoutMs: 1_000 });
      const first = show(request({}));
      expect(await show(request({}))).toEqual({ kind: "failed", reason: "busy" });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await first).toEqual({ kind: "failed", reason: "timeout" });
      expect(await show(request({ network: "monetag" }))).toEqual({ kind: "failed", reason: "unsupported" });
    } finally {
      vi.useRealTimers();
    }
    const empty: AdGlobals = {};
    const broken = createAdShower({ globals: () => empty, loader: { load: async () => Promise.reject(new Error("offline")) } });
    expect(await broken(request({}))).toEqual({ kind: "failed", reason: "load_failed" });
  });

  it("загрузчик: один адрес — одна вставка, неудача забывается и пробуется снова", async () => {
    const appended: string[] = [];
    let ok = false;
    const host: ScriptHost = { append: (src, _attributes, done) => (appended.push(src), done(ok)) };
    const loader = createScriptLoader(host);
    await expect(loader.load("https://a/sdk.js")).rejects.toThrow();
    ok = true;
    await Promise.all([loader.load("https://a/sdk.js"), loader.load("https://a/sdk.js")]);
    await loader.load("https://a/sdk.js");
    expect(appended).toEqual(["https://a/sdk.js", "https://a/sdk.js"]);
  });
});

describe("SDK сетей для учёта аудитории (Р78)", () => {
  const TADDY = [{ network: "taddy", keys: { pubId: PUB_ID } }];

  it("Taddy: скрипт с pubId в атрибуте, поднялся сам — только ready; повторный вызов SDK не трогает", async () => {
    const globals: AdGlobals = {};
    const calls: string[] = [];
    const { loader, loaded } = fakeLoader(globals, {
      [TADDY_SCRIPT]: (g) =>
        void (g.Taddy = {
          isInit: true,
          isReady: false,
          init: async () => void calls.push("init"),
          ready: async () => {
            calls.push("ready");
            if (g.Taddy !== undefined) g.Taddy.isReady = true;
          },
        }),
    });
    const prepare = createAudience({ globals: () => globals, loader });
    expect(await prepare(TADDY)).toEqual([{ network: "taddy", ok: true }]);
    expect(loaded).toEqual([{ src: TADDY_SCRIPT, attributes: { "data-pub-id": PUB_ID } }]);
    expect(calls).toEqual(["ready"]);
    expect(await prepare(TADDY)).toEqual([{ network: "taddy", ok: true }]);
    expect(calls).toEqual(["ready"]);
  });

  it("Taddy не поднялся сам — init с pubId, затем ready; SDK без этих методов — тоже не беда", async () => {
    const calls: string[] = [];
    const globals: AdGlobals = {};
    const { loader } = fakeLoader(globals, {
      [TADDY_SCRIPT]: (g) => void (g.Taddy = { isInit: false, init: async (pubId) => void calls.push(`init:${pubId}`), ready: async () => void calls.push("ready") }),
    });
    expect(await createAudience({ globals: () => globals, loader })(TADDY)).toEqual([{ network: "taddy", ok: true }]);
    expect(calls).toEqual([`init:${PUB_ID}`, "ready"]);

    const bare: AdGlobals = {};
    const plain = fakeLoader(bare, { [TADDY_SCRIPT]: (g) => void (g.Taddy = {}) });
    expect(await createAudience({ globals: () => bare, loader: plain.loader })(TADDY)).toEqual([{ network: "taddy", ok: true }]);
  });

  it("отказы — причиной, без исключения: нет скрипта, SDK бросил, SDK замолчал, нет ключа, незнакомая сеть", async () => {
    const offline = createAudience({ globals: () => ({}), loader: { load: async () => Promise.reject(new Error("offline")) } });
    expect(await offline(TADDY)).toEqual([{ network: "taddy", ok: false, reason: "load_failed" }]);

    const throwing: AdGlobals = { Taddy: { ready: async () => Promise.reject(new Error("Taddy: Telegram WebApp script is not loaded")) } };
    expect(await createAudience({ globals: () => throwing, loader: { load: async () => undefined } })(TADDY)).toEqual([{ network: "taddy", ok: false, reason: "sdk_error" }]);

    vi.useFakeTimers();
    try {
      const silent: AdGlobals = { Taddy: { ready: () => new Promise<void>(() => undefined) } };
      const pending = createAudience({ globals: () => silent, loader: { load: async () => undefined }, timeoutMs: 1_000 })(TADDY);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toEqual([{ network: "taddy", ok: false, reason: "timeout" }]);
    } finally {
      vi.useRealTimers();
    }

    const prepare = createAudience({ globals: () => ({}), loader: { load: async () => undefined } });
    expect(await prepare([{ network: "taddy", keys: {} }, { network: "monetag", keys: {} }])).toEqual([
      { network: "taddy", ok: false, reason: "misconfigured" },
      { network: "monetag", ok: false, reason: "unsupported" },
    ]);
  });
});
