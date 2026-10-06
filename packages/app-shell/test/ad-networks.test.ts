import type { AdNetworkSetup, PlatformAdapter } from "@bh/shared-types";
import { beforeEach, describe, expect, it } from "vitest";
import type { ZodMiniType } from "zod/mini";
import { fetchAdNetworks, interstitialExpected, prepareAdNetworks, resetAdNetworks, type AdNetworksResponse } from "../src/state/ad-networks";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { initShell, type ShellCapabilities } from "../src/state/shell";

/**
 * SDK рекламных сетей для учёта аудитории (docs/35-stage4-plan.md WP12,
 * часть 9): сервер решает, какие сети, адаптер поднимает их SDK — однажды за
 * запуск, и только там, где есть площадка и вход.
 */

const TADDY: AdNetworkSetup = { network: "taddy", keys: { pubId: "14cbeb980853dd416003462ca4db7c12" } };

function shellWith(prepared: AdNetworkSetup[][] | null, capabilities: Partial<ShellCapabilities> = {}): void {
  const adapter = (prepared === null ? {} : { prepareAds: async (networks: readonly AdNetworkSetup[]) => void prepared.push([...networks]) }) as unknown as PlatformAdapter;
  initShell({
    adapter,
    capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false, auth: { baseUrl: "" }, ...capabilities },
    storage: undefined,
    analytics: () => undefined,
    build: { version: "test", contentHash: "", platform: "telegram" },
  });
}

function api(...answers: ApiResult<AdNetworksResponse>[]): { asked: number; networks: () => Promise<ApiResult<AdNetworksResponse>> } {
  const queue = [...answers];
  const fake = {
    asked: 0,
    networks: async () => {
      fake.asked++;
      return queue.shift() ?? { ok: false as const, failure: "unavailable" as const };
    },
  };
  return fake;
}

describe("SDK сетей для учёта аудитории", () => {
  beforeEach(() => resetAdNetworks());

  it("сети от сервера — адаптеру, однажды за запуск", async () => {
    const prepared: AdNetworkSetup[][] = [];
    shellWith(prepared);
    const server = api({ ok: true, data: { networks: [TADDY] } });
    await prepareAdNetworks(server.networks);
    await prepareAdNetworks(server.networks);
    expect(prepared).toEqual([[TADDY]]);
    expect(server.asked).toBe(1);
  });

  it("тот же ответ говорит, ждать ли межстраничную; не знаем — `null`, и старт спросит сам", async () => {
    shellWith([]);
    expect(interstitialExpected()).toBeNull();
    await prepareAdNetworks(api({ ok: true, data: { networks: [], interstitial: false } }).networks);
    expect(interstitialExpected()).toBe(false);
    resetAdNetworks();
    await prepareAdNetworks(api({ ok: true, data: { networks: [], interstitial: true } }).networks);
    expect(interstitialExpected()).toBe(true);
    resetAdNetworks();
    // Сервер до межстраничной поля не отдавал.
    await prepareAdNetworks(api({ ok: true, data: { networks: [] } }).networks);
    expect(interstitialExpected()).toBeNull();
  });

  it("сервер не ответил — следующий заход на главную спросит снова; пустой список — адаптер не зовётся", async () => {
    const prepared: AdNetworkSetup[][] = [];
    shellWith(prepared);
    const server = api({ ok: false, failure: "offline" }, { ok: true, data: { networks: [] } });
    await prepareAdNetworks(server.networks);
    await prepareAdNetworks(server.networks);
    expect(server.asked).toBe(2);
    expect(prepared).toEqual([]);
  });

  it("площадка без таких сетей, игра без входа или мимо площадки — сервер не спрашивается", async () => {
    const server = api({ ok: true, data: { networks: [TADDY] } });
    shellWith(null);
    await prepareAdNetworks(server.networks);
    shellWith([], { auth: undefined });
    await prepareAdNetworks(server.networks);
    shellWith([], { platformAvailable: false });
    await prepareAdNetworks(server.networks);
    expect(server.asked).toBe(0);
  });

  it("ключи сетей — GET и разбор схемой", async () => {
    const sent: string[] = [];
    const request: ApiRequest = async <T,>(path: string, schema: object, init: { method: string }): Promise<ApiResult<T>> => {
      sent.push(`${init.method} ${path}`);
      const parsed = (schema as ZodMiniType<T>).safeParse({ networks: [TADDY] });
      return parsed.success ? { ok: true, data: parsed.data } : { ok: false, failure: "unavailable" };
    };
    const response = await fetchAdNetworks(request);
    expect(response.ok && response.data.networks).toEqual([TADDY]);
    expect(sent).toEqual(["GET /api/v1/ads/networks"]);
  });
});
