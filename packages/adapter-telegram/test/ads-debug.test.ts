import type { AdShowRequest } from "@bh/shared-types";
import { describe, expect, it, vi } from "vitest";
import { createAdShower } from "../src/ads/ad-shower";
import { ADSGRAM_SCRIPT, RICHADS_SCRIPT, type AdGlobals, type AdsgramController, type AdsgramResult } from "../src/ads/networks";

/**
 * Режим «тестовый или боевой» действует на вызов (tasks/T-0334): команда
 * проверяет обе сети в обоих режимах за один запуск, поэтому режим входит в
 * ключ кэша контроллера.
 */

const request = (patch: Partial<AdShowRequest>): AdShowRequest => ({ network: "adsgram", blockId: "123", format: "rewarded", keys: {}, ...patch });

function installer(globals: AdGlobals, install: Record<string, (globals: AdGlobals) => void>) {
  return {
    async load(src: string) {
      const setup = install[src.split("?")[0] ?? src];
      if (setup === undefined) throw new Error("нет такого скрипта");
      setup(globals);
    },
  };
}

const controller = (): AdsgramController => ({
  show: async (): Promise<AdsgramResult> => ({ done: true, description: "", state: "destroy", error: false }),
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  destroy: () => undefined,
});

describe("AdsGram: режим на вызов", () => {
  it("тестовый, затем боевой того же блока — два init; повтор в том же режиме init не повторяет", async () => {
    const globals: AdGlobals = {};
    const init = vi.fn(controller);
    const show = createAdShower({ globals: () => globals, loader: installer(globals, { [ADSGRAM_SCRIPT]: (g) => void (g.Adsgram = { init }) }) });
    await show(request({ debug: true }));
    await show(request({ debug: true }));
    await show(request({ debug: false }));
    await show(request({}));
    expect(init.mock.calls).toEqual([[{ blockId: "123", debug: true }], [{ blockId: "123", debug: false }]]);
  });

  it("сначала боевой, потом тестовый — то же в обратном порядке", async () => {
    const globals: AdGlobals = {};
    const init = vi.fn(controller);
    const show = createAdShower({ globals: () => globals, loader: installer(globals, { [ADSGRAM_SCRIPT]: (g) => void (g.Adsgram = { init }) }) });
    await show(request({}));
    await show(request({ debug: true }));
    expect(init.mock.calls).toEqual([[{ blockId: "123", debug: false }], [{ blockId: "123", debug: true }]]);
  });
});

describe("RichAds: режим на вызов", () => {
  function richads() {
    const initialize = vi.fn();
    let created = 0;
    class Controller {
      constructor() {
        created++;
      }
      initialize = initialize;
      triggerInterstitialVideo = async () => true;
      triggerInterstitialBanner = async () => true;
    }
    const globals: AdGlobals = {};
    const show = createAdShower({ globals: () => globals, loader: installer(globals, { [RICHADS_SCRIPT]: (g) => void (g.TelegramAdsController = Controller) }) });
    return { show, initialize, created: () => created };
  }
  const rich = (debug?: boolean) => request({ network: "richads", blockId: null, keys: { pubId: "1", appId: "2" }, ...(debug === undefined ? {} : { debug }) });

  it("смена режима — новый контроллер и initialize с новым debug; тот же режим подряд — один раз", async () => {
    const { show, initialize, created } = richads();
    await show(rich(true));
    await show(rich(true));
    await show(rich(false));
    await show(rich());
    expect(created()).toBe(2);
    expect(initialize.mock.calls).toEqual([[{ pubId: "1", appId: "2", debug: true }], [{ pubId: "1", appId: "2", debug: false }]]);
  });
});
