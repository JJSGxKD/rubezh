import { z } from "zod/mini";
import type { AdShowOutcome } from "@bh/shared-types";
import { testResultOf, testedEventOf, showRequestOf, type AdsCheckBlock, type AdsCheckNetwork, type AdsCheckOptions } from "../screens/ads-check-rules";
import { browserDeps, type AdShow } from "./ad-watch";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import type { AnalyticsEvent, AnalyticsPayload } from "./analytics";

/**
 * Проверка рекламы командой (docs/35-stage4-plan.md, Р165; tasks/T-0334): показ
 * блока напрямую через адаптер — без сессии выдачи, награды, кулдаунов и
 * воронки. Исход уходит на экран, в событие `ad_tested` и в отчёт серверу.
 */

const formatSchema = z.enum(["rewarded", "interstitial"]);

const catalogSchema = z.object({
  networks: z.array(
    z.object({
      network: z.string(),
      name: z.string(),
      active: z.boolean(),
      keys: z.record(z.string(), z.string()),
      formats: z.array(formatSchema),
    }),
  ),
  blocks: z.array(
    z.object({
      blockId: z.string(),
      network: z.string(),
      place: z.string(),
      format: formatSchema,
      externalId: z.nullable(z.string()),
      active: z.boolean(),
      platforms: z.array(z.string()),
    }),
  ),
});

export type AdsCheckCatalog = z.infer<typeof catalogSchema>;

export interface AdsCheckApi {
  catalog(): Promise<ApiResult<AdsCheckCatalog>>;
  sendResult(body: Record<string, unknown>): Promise<ApiResult<unknown>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createAdsCheckApi(request: ApiRequest = apiRequest): AdsCheckApi {
  return {
    catalog: () => request("/api/v1/tools/ads/catalog", catalogSchema, { method: "GET" }),
    sendResult: (body) => request("/api/v1/tools/ads/test-results", z.unknown(), { method: "POST", body }),
  };
}

export interface AdsCheckDeps {
  /** показ площадки; нет — SDK-рекламы на ней нет */
  show: AdShow | undefined;
  /** звук игры молчит, пока идёт ролик */
  mute<T>(task: () => Promise<T>): Promise<T>;
  now(): number;
  track(event: AnalyticsEvent, payload: AnalyticsPayload): void;
  api: AdsCheckApi;
}

export function browserAdsCheckDeps(): AdsCheckDeps {
  const { show, mute, track, now } = browserDeps();
  return { show, mute, track, now, api: createAdsCheckApi() };
}

/**
 * Показать блок и записать исход. Отказ отправки отчёта показ не ломает и не
 * задерживает: исход уже на экране.
 */
export async function runAdCheck(
  deps: AdsCheckDeps,
  block: AdsCheckBlock,
  network: AdsCheckNetwork,
  options: AdsCheckOptions,
): Promise<{ outcome: AdShowOutcome; ms: number }> {
  const startedAt = deps.now();
  const show = deps.show;
  const outcome: AdShowOutcome =
    show === undefined ? { kind: "failed", reason: "unsupported" } : await deps.mute(() => show(showRequestOf(block, network, options)));
  const ms = deps.now() - startedAt;
  deps.track("ad_tested", testedEventOf(block, outcome, options.live, ms));
  void Promise.resolve()
    .then(() => deps.api.sendResult(testResultOf(block, outcome, options.live, ms)))
    .catch(() => undefined);
  return { outcome, ms };
}
