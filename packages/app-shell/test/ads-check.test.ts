import type { AdShowOutcome, AdShowRequest } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import type { AdsCheckBlock, AdsCheckNetwork } from "../src/screens/ads-check-rules";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { createAdsCheckApi, runAdCheck, type AdsCheckDeps } from "../src/state/ads-check";

// Проверка рекламы командой (tasks/T-0334): показ напрямую через адаптер,
// исход — на экран, в событие и в отчёт; сбой отчёта показ не ломает.

const NETWORK: AdsCheckNetwork = { network: "adsgram", name: "AdsGram", active: true, keys: {}, formats: ["rewarded"] };
const BLOCK: AdsCheckBlock = { blockId: "b1", network: "adsgram", place: "wheel_spin", format: "rewarded", externalId: "123", active: true, platforms: ["telegram"] };

function setup(patch: Partial<AdsCheckDeps> & { outcome?: AdShowOutcome; failSend?: boolean } = {}) {
  const log: string[] = [];
  const shown: AdShowRequest[] = [];
  const events: { event: string; payload: Record<string, unknown> }[] = [];
  const sent: unknown[] = [];
  let clock = 1000;
  const deps: AdsCheckDeps = {
    show: async (request) => {
      log.push("show");
      shown.push(request);
      clock += 3100;
      return patch.outcome ?? { kind: "completed" };
    },
    mute: async (task) => {
      log.push("mute-in");
      const result = await task();
      log.push("mute-out");
      return result;
    },
    now: () => clock,
    track: (event, payload) => void events.push({ event, payload }),
    api: {
      catalog: async () => ({ ok: false, failure: "unavailable" }),
      sendResult: async (body) => {
        sent.push(body);
        if (patch.failSend === true) throw new Error("нет сети");
        return { ok: true, data: undefined };
      },
    },
    ...patch,
  };
  return { deps, log, shown, events, sent };
}

describe("runAdCheck", () => {
  it("показ обёрнут в mute; событие и отчёт — по одному; ms — разность now", async () => {
    const { deps, log, shown, events, sent } = setup();
    const result = await runAdCheck(deps, BLOCK, NETWORK, { live: false, startLike: false });
    expect(result).toEqual({ outcome: { kind: "completed" }, ms: 3100 });
    expect(log).toEqual(["mute-in", "show", "mute-out"]);
    expect(shown[0]).toMatchObject({ network: "adsgram", blockId: "123", debug: true });
    expect(events).toEqual([{ event: "ad_tested", payload: { network: "adsgram", format: "rewarded", live: false, outcome: "completed", ms: 3100 } }]);
    expect(sent).toEqual([{ network: "adsgram", format: "rewarded", blockId: "b1", live: false, outcome: "completed", ms: 3100 }]);
  });

  it("отказ отправки показ не ломает: ни исключения, ни потерянного исхода", async () => {
    const { deps } = setup({ failSend: true });
    await expect(runAdCheck(deps, BLOCK, NETWORK, { live: true, startLike: false })).resolves.toMatchObject({ outcome: { kind: "completed" } });
  });

  it("без показа на площадке — failed unsupported, show не зовётся, событие есть", async () => {
    const { deps, events } = setup({ show: undefined });
    const result = await runAdCheck(deps, BLOCK, NETWORK, { live: false, startLike: false });
    expect(result.outcome).toEqual({ kind: "failed", reason: "unsupported" });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ outcome: "failed", reason: "unsupported" });
  });
});

describe("клиент каталога", () => {
  function recorder(answer: unknown) {
    const calls: string[] = [];
    const request = (async <T,>(path: string, schema: object, init?: { method?: string }): Promise<ApiResult<T>> => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      const { z } = await import("zod/mini");
      const parsed = z.object({ data: schema as never }).safeParse({ data: answer });
      return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
    }) as ApiRequest;
    return { calls, request };
  }

  it("каталог — GET, отчёт — POST по своим адресам", async () => {
    const { calls, request } = recorder({ networks: [], blocks: [] });
    const api = createAdsCheckApi(request);
    expect((await api.catalog()).ok).toBe(true);
    await api.sendResult({ network: "adsgram", format: "rewarded", blockId: "b1", live: false, outcome: "closed", ms: 1 });
    expect(calls).toEqual(["GET /api/v1/tools/ads/catalog", "POST /api/v1/tools/ads/test-results"]);
  });

  it("схема отвергает блок с неизвестным форматом", async () => {
    const bad = { networks: [], blocks: [{ blockId: "b", network: "n", place: "p", format: "banner", externalId: null, active: true, platforms: [] }] };
    expect((await createAdsCheckApi(recorder(bad).request).catalog()).ok).toBe(false);
  });
});
