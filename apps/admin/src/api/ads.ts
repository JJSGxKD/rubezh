import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";
import { FLAG_PLATFORMS } from "./flags";

/**
 * Реклама (`/admin/ads`, docs/35-stage4-plan.md §3.7, WP12): сети — ключи,
 * включить и поставить в круг; блоки мест — завести и править; воронка
 * показов по сетям и местам. Читать — `ads.view`, менять — `ads.edit`.
 *
 * **Формы строятся по профилю сети с сервера** (`ads/ad-networks.ts`): какие
 * ключи нужны сети, какие форматы она умеет, какой у формата блок в кабинете
 * и как он выглядит. Место задаёт формат, поэтому форма предлагает только
 * места формата сети, а поле блока — с видом и примером из профиля. Те же
 * правила проверяет сервер; панель лишь не даёт отправить заведомо неверное.
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
export const PLATFORM_TITLES: Record<AdPlatform, string> = { telegram: "Telegram", max: "MAX", vk: "VK", web: "Браузер" };
export const DAYS_TITLES: Record<FunnelDays, string> = { 1: "сутки", 7: "неделя", 30: "месяц" };

/** Формат места словами; незнакомый от сервера новее панели — как есть. */
export const FORMAT_TITLES: Partial<Record<string, string>> = { rewarded: "видео за награду", interstitial: "полноэкранная без награды", task: "задание сети" };

/** Что значит условие успеха для того, кто заводит блок. */
export const SUCCESS_HINTS: Record<AdSuccess, string> = {
  view: "засчитывает ответ SDK: игрок досмотрел до конца",
  click: "засчитывает сервер по своему редиректу",
  cpa: "засчитывает сервер по подтверждению сети — может идти днями",
};

/**
 * Строки воронки без сети — пропуски рекламы: VIP получает награду места без
 * ролика (§3.6), и сессия пишется под именем пропуска, а не сети.
 */
export const PASS_TITLES: Partial<Record<string, string>> = { vip: "VIP без ролика" };

/** Имя сети строки воронки: сеть из каталога, пропуск — своим названием, незнакомое — ключом. */
export function funnelNetworkTitle(key: string, networks: readonly Pick<AdNetwork, "networkKey" | "name">[]): string {
  return networks.find((network) => network.networkKey === key)?.name ?? PASS_TITLES[key] ?? key;
}

/** Меньше двух сетей в месте — отказ единственной оставляет место пустым (критерий приёмки WP12). */
export const MIN_NETWORKS_PER_PLACE = 2;
export const EXTERNAL_ID_MAX = 128;
export const PRIORITY_MAX = 10_000;

const optionSchema = z.object({ value: z.string(), title: z.string(), hint: z.string() });

const fieldSchema = z.object({
  title: z.string(),
  hint: z.string(),
  example: z.string(),
  pattern: z.string(),
  options: z.array(optionSchema).optional(),
});
export type AdField = z.infer<typeof fieldSchema>;

const keyFieldSchema = fieldSchema.extend({ key: z.string() });
export type AdKeyField = z.infer<typeof keyFieldSchema>;

const formatSupportSchema = z.object({
  format: z.string(),
  title: z.string(),
  unit: fieldSchema.nullable(),
  success: z.array(z.enum(AD_SUCCESS)).min(1),
  maxActive: z.number().optional(),
  note: z.string().optional(),
});
export type AdFormatSupport = z.infer<typeof formatSupportSchema>;

const profileSchema = z.object({
  key: z.string(),
  title: z.string(),
  cabinet: z.string().nullable(),
  keys: z.array(keyFieldSchema),
  formats: z.array(formatSupportSchema),
  verified: z.boolean(),
});
export type AdNetworkProfile = z.infer<typeof profileSchema>;

const networkSchema = z.object({
  networkKey: z.string(),
  name: z.string(),
  active: z.boolean(),
  priority: z.number(),
  keys: z.record(z.string(), z.string()).default({}),
  /** обязательных ключей не хватает — сеть не включить */
  missing: z.array(z.string()).default([]),
  /** ключ не по виду — запись до профилей */
  problem: z.string().nullable().default(null),
});
export type AdNetwork = z.infer<typeof networkSchema>;

const blockSchema = z.object({
  blockId: z.string(),
  networkKey: z.string(),
  place: z.enum(AD_PLACES),
  externalId: z.string().nullable(),
  success: z.enum(AD_SUCCESS),
  active: z.boolean(),
  platforms: z.array(z.enum(AD_PLATFORMS)),
  devices: z.array(z.enum(AD_DEVICES)),
  /** блок не по профилю сети — выдача его пропускает */
  problem: z.string().nullable().default(null),
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
  profiles: z.array(profileSchema).default([]),
  /** какой формат ждёт место */
  formats: z.record(z.string(), z.string()).default({}),
  /** включены тестовые показы — сети крутят пробные ролики и не платят */
  testMode: z.boolean().default(false),
});
export type AdsView = z.infer<typeof viewSchema>;

/** Блок для сервера: `blockId: null` — новый, `externalId: null` — у формата нет блока в кабинете. */
export interface AdBlockInput {
  blockId: string | null;
  networkKey: string;
  place: AdPlace;
  externalId: string | null;
  success: AdSuccess;
  active: boolean;
  platforms: AdPlatform[];
  devices: AdDevice[];
}

export function fetchAds(api: AdminApi, days: FunnelDays): Promise<ApiResult<AdsView>> {
  return api.request("/ads", { query: { days }, schema: viewSchema });
}

export function saveNetwork(api: AdminApi, networkKey: string, form: NetworkForm): Promise<ApiResult<AdNetwork>> {
  const keys = Object.fromEntries(Object.entries(form.keys).map(([key, value]) => [key, value.trim()]));
  return api.request("/ads/networks", { method: "POST", body: { networkKey, active: form.active, priority: form.priority, keys }, schema: networkSchema });
}

export function saveBlock(api: AdminApi, block: AdBlockInput): Promise<ApiResult<AdBlock>> {
  const externalId = block.externalId?.trim() ?? "";
  return api.request("/ads/blocks", { method: "POST", body: { ...block, externalId: externalId === "" ? null : externalId }, schema: blockSchema });
}

export function profileOf(view: Pick<AdsView, "profiles">, networkKey: string): AdNetworkProfile | undefined {
  return view.profiles.find((profile) => profile.key === networkKey);
}

/** Формат сети для места; `undefined` — сеть в этом месте не показывает. */
export function supportFor(view: Pick<AdsView, "profiles" | "formats">, networkKey: string, place: AdPlace): AdFormatSupport | undefined {
  return profileOf(view, networkKey)?.formats.find((support) => support.format === view.formats[place]);
}

export interface PlaceOption {
  place: AdPlace;
  /** формат сети для места; `null` — сеть здесь не показывает */
  support: AdFormatSupport | null;
  /** почему место недоступно — словами; `null` — доступно */
  reason: string | null;
}

/** Места для формы блока: доступные — с форматом сети, остальные — с причиной, чтобы было видно, почему их нет. */
export function placeOptions(view: Pick<AdsView, "profiles" | "formats" | "places">, networkKey: string): PlaceOption[] {
  const profile = profileOf(view, networkKey);
  return view.places.map((place) => {
    const support = supportFor(view, networkKey, place) ?? null;
    const format = FORMAT_TITLES[view.formats[place] ?? ""] ?? view.formats[place] ?? "?";
    const reason = support !== null ? null : profile === undefined ? "сети нет в коде" : `месту нужен формат «${format}», у ${profile.title} его нет`;
    return { place, support, reason };
  });
}

/** Сеть может показывать: ключи заданы и по виду. */
export function networkReady(network: Pick<AdNetwork, "missing" | "problem">): boolean {
  return network.missing.length === 0 && network.problem === null;
}

/** Блок реально участвует в выдаче: включён, по профилю, а его сеть включена и с ключами. */
export function blockServable(view: Pick<AdsView, "networks">, block: Pick<AdBlock, "networkKey" | "active" | "problem">): boolean {
  const network = view.networks.find((candidate) => candidate.networkKey === block.networkKey);
  return block.active && block.problem === null && network !== undefined && network.active && networkReady(network);
}

export interface PlaceCoverage {
  place: AdPlace;
  /** сети, которые реально показываются в месте, по кругу */
  networks: string[];
}

/** Какие сети реально показываются в каждом месте: включённая сеть с ключами и включённый блок по профилю. */
export function coverage(view: Pick<AdsView, "networks" | "blocks" | "places">): PlaceCoverage[] {
  const active = view.networks.filter((network) => network.active).sort((a, b) => a.priority - b.priority || a.networkKey.localeCompare(b.networkKey));
  return view.places.map((place) => ({
    place,
    networks: active
      .filter((network) => view.blocks.some((block) => block.place === place && block.networkKey === network.networkKey && blockServable(view, block)))
      .map((network) => network.name),
  }));
}

/** Доля в процентах, без дробей: панели нужно «сеть отдаёт половину», а не третий знак. */
export function percent(part: number, whole: number): string {
  return whole === 0 ? "—" : `${String(Math.round((part / whole) * 100))}%`;
}

/** Где блок показывается: пустой список — везде. */
export function reachLabel(block: Pick<AdBlock, "platforms" | "devices">): string {
  const platforms = block.platforms.length === 0 ? "все площадки" : block.platforms.map((platform) => PLATFORM_TITLES[platform]).join(", ");
  const devices = block.devices.length === 0 ? "все устройства" : block.devices.map((device) => DEVICE_TITLES[device]).join(", ");
  return `${platforms}; ${devices}`;
}

function matches(field: AdField, value: string): boolean {
  return new RegExp(field.pattern).test(value);
}

/** Форма сети: ключи по профилю, место в круге и включённость. */
export interface NetworkForm {
  active: boolean;
  priority: number;
  keys: Record<string, string>;
}

export function networkFormOf(network: AdNetwork, profile: AdNetworkProfile | undefined): NetworkForm {
  const keys = Object.fromEntries((profile?.keys ?? []).map((field) => [field.key, network.keys[field.key] ?? ""]));
  return { active: network.active, priority: network.priority, keys };
}

/**
 * Схема формы сети по её профилю: каждый ключ — пустой или по виду из
 * кабинета; включить можно, только когда заданы все ключи. Ошибка — у поля,
 * которое её вызвало.
 */
export function networkFormSchema(profile: AdNetworkProfile | undefined) {
  return z
    .object({
      active: z.boolean(),
      priority: z.number({ error: "Место в круге — число" }).int("Место в круге — целое").min(0, "Не меньше 0").max(PRIORITY_MAX, `Не больше ${String(PRIORITY_MAX)}`),
      keys: z.record(z.string(), z.string()),
    })
    .superRefine((form, ctx) => {
      for (const field of profile?.keys ?? []) {
        const value = (form.keys[field.key] ?? "").trim();
        if (value === "") {
          if (form.active) ctx.addIssue({ code: "custom", path: ["keys", field.key], message: "Без этого ключа сеть не включить" });
        } else if (!matches(field, value)) {
          ctx.addIssue({ code: "custom", path: ["keys", field.key], message: `Не похоже на значение из кабинета — пример «${field.example}»` });
        }
      }
      if (form.active && profile === undefined) ctx.addIssue({ code: "custom", path: ["active"], message: "Сети нет в коде — включать нечего" });
    });
}

/** Форма блока: пустая строка у места и условия — ещё не выбрано. */
export interface BlockForm {
  networkKey: string;
  place: AdPlace | "";
  externalId: string;
  success: AdSuccess | "";
  active: boolean;
  platforms: AdPlatform[];
  devices: AdDevice[];
}

export function emptyBlockForm(networkKey = ""): BlockForm {
  return { networkKey, place: "", externalId: "", success: "", active: true, platforms: [], devices: [] };
}

export function blockFormOf(block: AdBlock): BlockForm {
  return { networkKey: block.networkKey, place: block.place, externalId: block.externalId ?? "", success: block.success, active: block.active, platforms: [...block.platforms], devices: [...block.devices] };
}

/**
 * Схема формы блока по профилям сетей: место — из форматов сети, блок в
 * кабинете — с видом формата или пустой, если формат показывается по ключам
 * сети; условие успеха — из допустимых форматом; включённых блоков формата —
 * не больше, чем держит кабинет. Ошибка — у поля, которое её вызвало.
 */
export function blockFormSchema(view: Pick<AdsView, "profiles" | "formats" | "blocks">, editing: string | null) {
  const unique = <T>(list: readonly T[]) => new Set(list).size === list.length;
  return z
    .object({
      networkKey: z.string().min(1, "Выберите сеть"),
      place: z.union([z.enum(AD_PLACES), z.literal("")]),
      externalId: z.string().max(EXTERNAL_ID_MAX, `До ${String(EXTERNAL_ID_MAX)} знаков`),
      success: z.union([z.enum(AD_SUCCESS), z.literal("")]),
      active: z.boolean(),
      platforms: z.array(z.enum(AD_PLATFORMS)).refine(unique),
      devices: z.array(z.enum(AD_DEVICES)).refine(unique),
    })
    .superRefine((form, ctx) => {
      if (form.networkKey === "") return;
      const profile = profileOf(view, form.networkKey);
      if (profile === undefined) {
        ctx.addIssue({ code: "custom", path: ["networkKey"], message: "Сети нет в коде — её SDK не подключён" });
        return;
      }
      if (form.place === "") {
        ctx.addIssue({ code: "custom", path: ["place"], message: "Выберите место" });
        return;
      }
      const support = supportFor(view, form.networkKey, form.place);
      if (support === undefined) {
        ctx.addIssue({ code: "custom", path: ["place"], message: `${profile.title} не показывает в этом месте` });
        return;
      }
      const unit = form.externalId.trim();
      if (support.unit === null) {
        if (unit !== "") ctx.addIssue({ code: "custom", path: ["externalId"], message: "У формата нет блока в кабинете — показ по ключам сети" });
      } else if (unit === "") {
        ctx.addIssue({ code: "custom", path: ["externalId"], message: support.unit.options === undefined ? `Нужен ${support.unit.title} — пример «${support.unit.example}»` : `Выберите: ${support.unit.title.toLowerCase()}` });
      } else if (!matches(support.unit, unit)) {
        ctx.addIssue({ code: "custom", path: ["externalId"], message: `${support.unit.title} для этого места выглядит как «${support.unit.example}»` });
      }
      if (form.success !== "" && !support.success.includes(form.success)) {
        ctx.addIssue({ code: "custom", path: ["success"], message: `Здесь успех — ${support.success.map((success) => SUCCESS_TITLES[success]).join(" или ")}` });
      }
      if (form.active && support.maxActive !== undefined) {
        const others = view.blocks.filter(
          (block) => block.active && block.blockId !== editing && block.networkKey === form.networkKey && view.formats[block.place] === support.format,
        );
        if (others.length >= support.maxActive) {
          ctx.addIssue({ code: "custom", path: ["active"], message: `${profile.title} держит ${String(support.maxActive)} включённый блок этого формата — выключите прежний` });
        }
      }
    });
}

/** Блок для сервера из формы: пустой идентификатор — блока нет, условие не выбрано — первое из допустимых. */
export function blockInputOf(view: Pick<AdsView, "profiles" | "formats">, form: BlockForm, blockId: string | null): AdBlockInput | null {
  if (form.place === "") return null;
  const support = supportFor(view, form.networkKey, form.place);
  if (support === undefined) return null;
  const externalId = form.externalId.trim();
  return {
    blockId,
    networkKey: form.networkKey,
    place: form.place,
    externalId: externalId === "" ? null : externalId,
    success: form.success === "" ? (support.success[0] ?? "view") : form.success,
    active: form.active,
    platforms: form.platforms,
    devices: form.devices,
  };
}
