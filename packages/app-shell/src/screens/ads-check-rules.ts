import type { AdShowOutcome, AdShowRequest } from "@bh/shared-types";
import { t } from "../i18n";

/**
 * Правила экрана «Проверка рекламы» (docs/35-stage4-plan.md, Р165; tasks/T-0334)
 * без React: запрос показа, исход строкой, тело отчёта и событие, группы
 * каталога и вид экрана.
 */

export type AdsCheckFormat = "rewarded" | "interstitial";

export interface AdsCheckNetwork {
  network: string;
  name: string;
  active: boolean;
  keys: Record<string, string>;
  formats: AdsCheckFormat[];
}

export interface AdsCheckBlock {
  blockId: string;
  network: string;
  place: string;
  format: AdsCheckFormat;
  externalId: string | null;
  active: boolean;
  platforms: string[];
}

export interface AdsCheckOptions {
  /** боевой показ; по умолчанию тестовый — сеть его не засчитывает */
  live: boolean;
  /** с окном подготовки, как при старте забега */
  startLike: boolean;
}

/** Окно подготовки межстраничной при старте забега. */
const START_READY_MS = 2000;

/** Предел `ms` в отчёте — тот же, что у сервера. */
const MAX_MS = 600_000;

const KNOWN_PLACES: ReadonlySet<string> = new Set(["second_chance", "wheel_spin", "run_double", "interstitial"]);

const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Сети в порядке ответа, блоки внутри — по месту, затем по id; блок неизвестной сети пропускается. */
export function groupCatalog(networks: readonly AdsCheckNetwork[], blocks: readonly AdsCheckBlock[]): { network: AdsCheckNetwork; blocks: AdsCheckBlock[] }[] {
  return networks.map((network) => ({
    network,
    blocks: blocks.filter((block) => block.network === network.network).sort((a, b) => text(a.place, b.place) || text(a.blockId, b.blockId)),
  }));
}

export function showRequestOf(block: AdsCheckBlock, network: AdsCheckNetwork, options: AdsCheckOptions): AdShowRequest {
  return {
    network: block.network,
    blockId: block.externalId,
    format: block.format,
    keys: network.keys,
    debug: !options.live,
    ...(block.format === "interstitial" && options.startLike ? { readyWithinMs: START_READY_MS } : {}),
  };
}

const seconds = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function outcomeLabel(outcome: AdShowOutcome, ms: number): string {
  const sec = seconds.format(ms / 1000);
  if (outcome.kind === "completed") return t("adsCheck.outcome.completed", { sec });
  if (outcome.kind === "closed") return t("adsCheck.outcome.closed", { sec });
  if (outcome.reason === "no_fill") return t("adsCheck.outcome.noFill", { sec });
  return t("adsCheck.outcome.failed", { reason: outcome.reason, sec });
}

export function placeLabel(place: string): string {
  return KNOWN_PLACES.has(place) ? t(`adsCheck.place.${place}`) : place;
}

const clampMs = (ms: number): number => Math.min(MAX_MS, Math.max(0, Math.round(ms)));

/** Тело `POST /api/v1/tools/ads/test-results`. */
export function testResultOf(block: AdsCheckBlock, outcome: AdShowOutcome, live: boolean, ms: number): Record<string, unknown> {
  return {
    network: block.network,
    format: block.format,
    blockId: block.blockId,
    live,
    outcome: outcome.kind,
    ...(outcome.kind === "failed" ? { reason: outcome.reason } : {}),
    ms: clampMs(ms),
  };
}

/** Полезная нагрузка события `ad_tested`. */
export function testedEventOf(block: AdsCheckBlock, outcome: AdShowOutcome, live: boolean, ms: number): Record<string, string | number | boolean> {
  return {
    network: block.network,
    format: block.format,
    live,
    outcome: outcome.kind,
    ...(outcome.kind === "failed" ? { reason: outcome.reason } : {}),
    ms: clampMs(ms),
  };
}

export type AdsCheckLoad = "loading" | "error" | "empty" | "ready";
export type AdsCheckView = "denied" | AdsCheckLoad | "unsupported";

/** Что рисовать: сначала право, потом площадка, потом состояние каталога. */
export function adsCheckView(admin: boolean, playable: boolean, load: AdsCheckLoad): AdsCheckView {
  if (!admin) return "denied";
  if (!playable) return "unsupported";
  return load;
}
