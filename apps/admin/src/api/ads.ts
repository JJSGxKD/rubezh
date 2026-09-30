import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";
import { FLAG_PLATFORMS } from "./flags";

/**
 * Реклама (`/admin/ads`, docs/35-stage4-plan.md §3.7, WP12): сети — включить
 * и поставить в круг, блоки мест — завести и править, воронка показов по
 * сетям и местам. Читать — `ads.view`, менять — `ads.edit`. Удаления нет:
 * блок выключают, на него ссылаются показы. Сеть и место блока после
 * создания не меняются.
 */

export const AD_PLACES = ["second_chance", "wheel_spin", "run_double", "task", "interstitial"] as const;
export type AdPlace = (typeof AD_PLACES)[number];
export const AD_SUCCESS = ["view", "click", "cpa"] as const;
export type AdSuccess = (typeof AD_SUCCESS)[number];
export const AD_DEVICES = ["android", "ios", "desktop", "web"] as const;
export type AdDevice = (typeof AD_DEVICES)[number];
export const AD_PLATFORMS = FLAG_PLATFORMS;
export type AdPlatform = (typeof AD_PLATFORMS)[number];
export const FUNNEL_DAYS = [1, 7, 30] as const;
export type FunnelDays = (typeof FUNNEL_DAYS)[number];

export const PLACE_TITLES: Record<AdPlace, string> = {
  second_chance: "Второй шанс",
  wheel_spin: "Крутка колеса",
  run_double: "Удвоение за забег",
  task: "Задания",
  interstitial: "Между забегами",
};
export const SUCCESS_TITLES: Record<AdSuccess, string> = { view: "показ", click: "клик", cpa: "целевое действие" };
export const DEVICE_TITLES: Record<AdDevice, string> = { android: "Android", ios: "iOS", desktop: "десктоп", web: "браузер" };
export const DAYS_TITLES: Record<FunnelDays, string> = { 1: "сутки", 7: "неделя", 30: "месяц" };

/** Меньше двух сетей в месте — отказ единственной оставляет место пустым (критерий приёмки WP12). */
export const MIN_NETWORKS_PER_PLACE = 2;
export const EXTERNAL_ID_MAX = 128;

const networkSchema = z.object({ networkKey: z.string(), name: z.string(), active: z.boolean(), priority: z.number() });
export type AdNetwork = z.infer<typeof networkSchema>;

const blockSchema = z.object({
  blockId: z.string(),
  networkKey: z.string(),
  place: z.enum(AD_PLACES),
  externalId: z.string(),
  success: z.enum(AD_SUCCESS),
  active: z.boolean(),
  platforms: z.array(z.enum(AD_PLATFORMS)),
  devices: z.array(z.enum(AD_DEVICES)),
});
export type AdBlock = z.infer<typeof blockSchema>;

const funnelSchema = z.object({
  networkKey: z.string(),
  place: z.enum(AD_PLACES),
  offered: z.number(),
  shown: z.number(),
  clicked: z.number(),
  completed: z.number(),
  claimed: z.number(),
  failed: z.number(),
});
export type AdFunnelRow = z.infer<typeof funnelSchema>;

const viewSchema = z.object({
  networks: z.array(networkSchema),
  blocks: z.array(blockSchema),
  funnel: z.array(funnelSchema),
  days: z.union([z.literal(1), z.literal(7), z.literal(30)]),
  places: z.array(z.enum(AD_PLACES)),
});
export type AdsView = z.infer<typeof viewSchema>;

/** Блок формы: `blockId: null` — новый. */
export type AdBlockInput = Omit<AdBlock, "blockId"> & { blockId: string | null };

export function fetchAds(api: AdminApi, days: FunnelDays): Promise<ApiResult<AdsView>> {
  return api.request("/ads", { query: { days }, schema: viewSchema });
}

export function saveNetwork(api: AdminApi, network: Pick<AdNetwork, "networkKey" | "active" | "priority">): Promise<ApiResult<AdNetwork>> {
  return api.request("/ads/networks", { method: "POST", body: { networkKey: network.networkKey, active: network.active, priority: network.priority }, schema: networkSchema });
}

export function saveBlock(api: AdminApi, block: AdBlockInput): Promise<ApiResult<AdBlock>> {
  return api.request("/ads/blocks", { method: "POST", body: { ...block, externalId: block.externalId.trim() }, schema: blockSchema });
}

/** Что не так с формой блока; `null` — можно сохранять. Сервер проверит то же и что сеть и место не менялись. */
export function blockProblem(block: AdBlockInput, networks: readonly AdNetwork[]): string | null {
  if (!networks.some((network) => network.networkKey === block.networkKey)) return "Выберите сеть";
  const id = block.externalId.trim();
  if (id === "") return "Идентификатор блока — из кабинета сети";
  if (/\s/.test(id)) return "В идентификаторе блока нет пробелов — скопируйте его из кабинета сети целиком";
  if (id.length > EXTERNAL_ID_MAX) return `Идентификатор блока — до ${String(EXTERNAL_ID_MAX)} знаков`;
  return null;
}

export function priorityProblem(priority: number): string | null {
  return Number.isInteger(priority) && priority >= 0 && priority <= 10_000 ? null : "Место в круге — целое от 0 до 10 000";
}

export interface PlaceCoverage {
  place: AdPlace;
  /** включённые сети с включённым блоком места, по кругу */
  networks: string[];
}

/** Какие сети реально показываются в каждом месте: включённая сеть и включённый блок. */
export function coverage(view: Pick<AdsView, "networks" | "blocks" | "places">): PlaceCoverage[] {
  const active = view.networks.filter((network) => network.active).sort((a, b) => a.priority - b.priority || a.networkKey.localeCompare(b.networkKey));
  return view.places.map((place) => ({
    place,
    networks: active.filter((network) => view.blocks.some((block) => block.active && block.place === place && block.networkKey === network.networkKey)).map((network) => network.name),
  }));
}

/** Доля в процентах, без дробей: панели нужно «сеть отдаёт половину», а не третий знак. */
export function percent(part: number, whole: number): string {
  return whole === 0 ? "—" : `${String(Math.round((part / whole) * 100))}%`;
}

/** Где блок показывается: пустой список — везде. */
export function reachLabel(block: Pick<AdBlock, "platforms" | "devices">): string {
  const platforms = block.platforms.length === 0 ? "все площадки" : block.platforms.join(", ");
  const devices = block.devices.length === 0 ? "все устройства" : block.devices.map((device) => DEVICE_TITLES[device]).join(", ");
  return `${platforms}; ${devices}`;
}
