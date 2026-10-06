import type { AdShowOutcome, AdShowRequest } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import type { CreativeHooks, CreativeResult, CreativeShow } from "../src/ads/ad-creative";
import type { AdWatchDeps } from "../src/state/ad-watch";
import { offerBody, type AdOffer, type AdStep } from "../src/state/ads-api";
import type { ApiResult } from "../src/state/api-request";
import { INTERSTITIAL_WAIT_MS, interstitialBeforeRun } from "../src/state/interstitial";

/**
 * Межстраничная при старте забега (docs/35-stage4-plan.md WP12, часть 10):
 * решает сервер, клиент спрашивает с моментом; на выдачу и подготовку —
 * две секунды на всё, попытка одна, опоздавшая выдача закрывается отказом.
 */

const LATER = new Date(Date.UTC(2026, 9, 2, 12)).toISOString();

function offer(network: string, patch: Partial<Extract<AdOffer, { available: true }>> = {}): ApiResult<AdOffer> {
  return {
    ok: true,
    data: { available: true, sessionId: `session-${network}`, network, blockId: "int-1", format: "interstitial", keys: {}, success: "view", expiresAt: LATER, pass: null, ...patch },
  };
}

const CREATIVE = {
  ad: { id: "taddy-ad-1", title: "Рубеж держит", description: null, text: null, image: null, icon: null, button: null, link: "https://t.me/example_bot", advertiser: "Taddy" },
  viewSec: 5,
};

/** Часы теста идут только тогда, когда их двигает выдача или ожидание. */
function harness(options: { answer: () => Promise<ApiResult<AdOffer>>; outcome?: AdShowOutcome; creative?: (hooks: CreativeHooks) => CreativeResult; serverMs?: number }) {
  let clock = 0;
  const asked: { place: string; moment: string | undefined }[] = [];
  const shown: AdShowRequest[] = [];
  const creatives: CreativeShow[] = [];
  const reports: { sessionId: string; step: AdStep }[] = [];
  const events: { event: string; payload: Record<string, unknown> }[] = [];
  const deps: AdWatchDeps = {
    ads: {
      offer: async (place, _viewer, moment) => {
        asked.push({ place, moment });
        const answer = await options.answer();
        clock += options.serverMs ?? 100;
        return answer;
      },
      report: async (sessionId, step) => (reports.push({ sessionId, step }), { ok: true, data: { ok: true } }),
    },
    show: async (request) => (shown.push(request), options.outcome ?? { kind: "completed" }),
    showCreative: async (show, hooks) => {
      creatives.push(show);
      hooks.onShown();
      return options.creative?.(hooks) ?? { kind: "completed" };
    },
    openLink: () => undefined,
    viewer: { device: "android", language: "ru", premium: null },
    mute: async (task) => await task(),
    track: (event, payload) => void events.push({ event, payload: { ...payload } }),
    now: () => clock,
    sleep: async (ms) => {
      // Срок выдачи истекает, только если сервер в тесте медленнее него; иначе первым приходит ответ.
      if ((options.serverMs ?? 0) < ms) return await new Promise<void>(() => undefined);
      clock += ms;
    },
  };
  return { deps, asked, shown, creatives, reports, events };
}

describe("межстраничная при старте забега", () => {
  it("спрашивает с моментом; сервер сказал «не время» — забег сразу, без показа и шагов", async () => {
    const h = harness({ answer: async () => ({ ok: true, data: { available: false, reason: "policy", retryAt: null } }) });
    expect(await interstitialBeforeRun("run_start", () => true, h.deps)).toBe("skipped");
    expect(h.asked).toEqual([{ place: "interstitial", moment: "run_start" }]);
    expect(h.shown).toEqual([]);
    expect(h.reports).toEqual([]);
    expect(offerBody("interstitial", null, "run_start")).toEqual({ place: "interstitial", moment: "run_start" });
    expect(offerBody("wheel_spin", { device: "ios", language: null, premium: null })).toEqual({ place: "wheel_spin", device: "ios" });
  });

  it("SDK сети получает остаток двух секунд на скрипт; показ — шагом серверу и событием с моментом", async () => {
    const h = harness({ answer: async () => offer("adsgram"), serverMs: 300 });
    expect(await interstitialBeforeRun("run_start", () => true, h.deps)).toBe("shown");
    expect(h.shown).toEqual([{ network: "adsgram", blockId: "int-1", format: "interstitial", keys: {}, debug: false, readyWithinMs: INTERSTITIAL_WAIT_MS - 300 }]);
    expect(h.reports).toEqual([{ sessionId: "session-adsgram", step: { outcome: "completed" } }]);
    expect(h.events).toEqual([{ event: "ad_shown", payload: { place: "interstitial", network: "adsgram", moment: "run_start", completed: true, ms: 300 } }]);
  });

  it("отказ сети — одна попытка: второй сети подряд нет, забег не ждёт", async () => {
    const h = harness({ answer: async () => offer("adsgram"), outcome: { kind: "failed", reason: "no_fill" } });
    expect(await interstitialBeforeRun("run_start", () => true, h.deps)).toBe("skipped");
    expect(h.asked).toHaveLength(1);
    expect(h.reports).toEqual([{ sessionId: "session-adsgram", step: { outcome: "failed", reason: "no_fill" } }]);
    expect(h.events[0]).toMatchObject({ event: "ad_failed", payload: { reason: "no_fill", attempt: 1, moment: "run_start" } });
  });

  it("креатив сети с API — нашим блоком без награды, со сроком; клик — с моментом", async () => {
    const h = harness({
      answer: async () => offer("taddy", { blockId: null, creative: CREATIVE }),
      creative: (hooks) => (hooks.onClick(), { kind: "completed" }),
    });
    expect(await interstitialBeforeRun("run_start", () => true, h.deps)).toBe("shown");
    expect(h.creatives).toEqual([{ ad: CREATIVE.ad, viewSec: 5, rewarded: false, readyWithinMs: INTERSTITIAL_WAIT_MS - 100 }]);
    expect(h.events.map((item) => item.event)).toEqual(["ad_clicked", "ad_shown"]);
    expect(h.events[0]?.payload).toEqual({ place: "interstitial", network: "taddy", moment: "run_start" });
    expect(h.reports.map((report) => report.step.outcome)).toEqual(["shown", "clicked", "completed"]);
  });

  it("выдача дольше двух секунд — забег без рекламы, а опоздавшая сессия закрывается отказом `late`", async () => {
    let answer: (value: ApiResult<AdOffer>) => void = () => undefined;
    const h = harness({ answer: () => new Promise((resolve) => (answer = resolve)), serverMs: INTERSTITIAL_WAIT_MS });
    expect(await interstitialBeforeRun("run_start", () => true, h.deps)).toBe("skipped");
    answer(offer("adsgram"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.shown).toEqual([]);
    expect(h.reports).toEqual([{ sessionId: "session-adsgram", step: { outcome: "failed", reason: "late" } }]);
    expect(h.events[0]).toMatchObject({ event: "ad_failed", payload: { reason: "late", moment: "run_start" } });
  });

  it("ушёл в меню, пока сервер думал, — показа нет, сессия закрыта отказом", async () => {
    const h = harness({ answer: async () => offer("adsgram") });
    expect(await interstitialBeforeRun("run_start", () => false, h.deps)).toBe("skipped");
    expect(h.shown).toEqual([]);
    expect(h.reports).toEqual([{ sessionId: "session-adsgram", step: { outcome: "failed", reason: "late" } }]);
  });

  it("сервер недоступен — забег без рекламы", async () => {
    const h = harness({ answer: async () => ({ ok: false, failure: "offline" }) });
    expect(await interstitialBeforeRun("run_start", () => true, h.deps)).toBe("skipped");
    expect(h.events).toEqual([]);
  });
});
