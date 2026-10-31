import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";
import type { FunnelRow, Period } from "./funnel";
import { LINK_NETWORKS, LINK_TARGETS } from "./links";

/**
 * Партнёры (`/admin/partners`, docs/35-stage4-plan.md WP41, часть 2): кто
 * приводит игроков своими промокодами и что эти игроки принесли. Смотрят под
 * `partners.view`, заводят и правят под `partners.edit`. Условия партнёра —
 * TG id, страна, валюта, способ выплаты, процент — только записываются
 * (Р96, О44), а статус решает, привязывает ли партнёр новых игроков.
 */

/** Статус партнёра; сервер знает тот же список (`partners/partner-rules.ts`). */
export const PARTNER_STATUSES = ["applied", "active", "paused", "rejected"] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

export const STATUS_TITLES: Record<PartnerStatus, string> = { applied: "заявка", active: "активен", paused: "приостановлен", rejected: "отклонён" };

type StatusTone = "success" | "info" | "warning" | "neutral";

const STATUS_TONES: Record<PartnerStatus, StatusTone> = { applied: "info", active: "success", paused: "warning", rejected: "neutral" };

/** Тон значка статуса: активен — успех, заявка — сведения, приостановлен — предупреждение, отклонён — приглушённый. */
export function statusTone(status: PartnerStatus): StatusTone {
  return STATUS_TONES[status];
}

/** Новых игроков к партнёру привязывает только активный; прежние привязки статус не трогает. */
export function bindsNewPlayers(status: PartnerStatus): boolean {
  return status === "active";
}

/** Валюты выплаты — коды ядра курсов (`@bh/fx`); панель с ним не связана, список тот же, что у сервера. */
export const PAYOUT_CURRENCIES = ["USD", "EUR", "RUB", "GRAM", "USDT", "XTR"] as const;

/** Подсказки условий. Словарь подсказок панели (`ui/help.ts`) вне зон T-0066, поэтому тексты — рядом с полями. */
export const TERMS_HELP = {
  telegramId: "Telegram ID партнёра — число, для будущего входа в его кабинет. Уникален среди партнёров. Узнать его можно у бота @userinfobot.",
  status: "Решает, привязывает ли партнёр новых игроков: только активный. Код партнёра в любом другом статусе даёт свою награду, но игрока за партнёром не записывает. Приведённые раньше остаются за ним.",
  country: "Где партнёр получает выплаты: две заглавные буквы по ISO, например KZ или RU.",
  payoutCurrency: "В чём партнёр получает выплаты — код из списка курсов. Смена валюты и страны пишется в аудит: выплаты считаются по тому, что стояло на дату начисления.",
  payoutMethod: "Реквизиты словами: «USDT TRC-20 на T…», «карта Тинькофф». До двухсот знаков.",
  sharePercent: "Доля от платежей приведённых игроков, от 0 до 100. Начисления — после модели учёта (docs/37-accounting.md), сейчас только запись договорённости.",
} as const;

/** Подсказки блока ссылок. Словарь подсказок панели (`ui/help.ts`) вне зон T-0067, поэтому тексты — рядом с блоком. */
export const LINKS_HELP =
  "Ссылки, заведённые от имени партнёра, — для его постов и закупки рекламы. Новичок, впервые пришедший по ссылке, записывается за партнёром, если тот активен, аккаунт не старше окна привязки и игрока ещё никто не привёл. Клики и запуски — те же числа, что в разделе «Ссылки».";
export const LINKS_BOUND_HELP = "Сколько приведённых игроков записаны по ссылкам партнёра. Остальные привязаны его промокодами; слот источника у игрока один.";
export const NO_LINK_FOR_INACTIVE = "Ссылку заводят только активному партнёру: игроков по ней всё равно никто бы не привязал";
export const NO_BINDING_NOTE = "Новые игроки к партнёру не привязываются";
export const NO_ACCRUAL_NOTE = "начисления — после модели учёта";

/** Подсказки блока воронки партнёра. Словарь подсказок панели (`ui/help.ts`) вне зон T-0068, поэтому тексты — рядом с блоком. */
export const FUNNEL_HELP = {
  block:
    "Что делают игроки, привязанные к партнёру, — те же девять вех, что в разделе «Воронка». Период считается по дате привязки к партнёру, а не по первому визиту: так видно, как давно партнёр приводит игроков. Пришедшие по его ссылке, но привязанные к другому, сюда не входят.",
  sources: "Откуда игрок привязан: по ссылке партнёра (кампания и код) или по его промокоду (название кампании). Ссылка с двух площадок — одна строка. Если ссылку или код потом удалили, строка так и называется.",
  platforms: "Те же игроки по площадкам их аккаунтов: где партнёр приводит больше и где игроки доходят дальше.",
} as const;

export const NO_FUNNEL_PLAYERS = "За период к партнёру никто не привязан";

const statsSchema = z.object({
  codes: z.number(),
  activeCodes: z.number(),
  redeemed: z.number(),
  bound: z.number(),
  played: z.number(),
  payers: z.number(),
  stars: z.number(),
});
export type PartnerStats = z.infer<typeof statsSchema>;

const partnerSchema = z.object({
  partnerId: z.string(),
  name: z.string(),
  contact: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  telegramId: z.string().nullable(),
  status: z.enum(PARTNER_STATUSES),
  country: z.string().nullable(),
  payoutCurrency: z.string().nullable(),
  payoutMethod: z.string().nullable(),
  /** процент строкой с двумя знаками: «12.50» */
  sharePercent: z.string().nullable(),
  stats: statsSchema,
});
export type Partner = z.infer<typeof partnerSchema>;

const rulesSchema = z.object({ bindWindowDays: z.number() });

const catalogSchema = z.object({ partners: z.array(partnerSchema), rules: rulesSchema });
export type PartnerCatalog = z.infer<typeof catalogSchema>;

/** Ссылка партнёра в его карточке: те же клики и запуски, что в списке ссылок, и сколько игроков она привязала. */
const partnerLinkSchema = z.object({
  code: z.string(),
  campaign: z.string(),
  source: z.string().nullable(),
  // Цель и сеть, о которых панель ещё не знает, не ломают карточку: цель читается как Mini App, сеть — как её отсутствие.
  target: z.enum(LINK_TARGETS).catch("app"),
  network: z.enum(LINK_NETWORKS).nullable().catch(null),
  createdAt: z.string(),
  clicks: z.number(),
  clicks30d: z.number(),
  launches: z.number(),
  directLaunches: z.number(),
  bound: z.number(),
});
export type PartnerLink = z.infer<typeof partnerLinkSchema>;

const detailSchema = z.object({
  partner: partnerSchema,
  daily: z.array(z.object({ day: z.string(), count: z.number() })),
  codes: z.array(
    z.object({
      campaignId: z.string(),
      title: z.string(),
      kind: z.enum(["shared", "batch"]),
      codeSample: z.string(),
      redeemed: z.number(),
      maxRedemptions: z.number().nullable(),
      startsAt: z.string(),
      endsAt: z.string().nullable(),
      pausedAt: z.string().nullable(),
      bound: z.number(),
      state: z.string(),
    }),
  ),
  // Сервер старее ссылок партнёра: блока нет, карточка показывает пустой.
  links: z.array(partnerLinkSchema).catch([]),
  /** игроков, привязанных по ссылкам; привязанные кодами сюда не входят */
  linkBound: z.number().catch(0),
  rules: rulesSchema,
});
export type PartnerDetail = z.infer<typeof detailSchema>;

export interface PartnerForm {
  name: string;
  contact: string;
  note: string;
  telegramId: string;
  country: string;
  payoutCurrency: string;
  payoutMethod: string;
  sharePercent: string;
}

export const PARTNER_LIMITS = { nameMin: 2, nameMax: 80, contactMax: 120, noteMax: 500, payoutMethodMax: 200, reasonMin: 3, reasonMax: 200 } as const;

/** Пустое поле условий можно; непустое — по правилу сервера (`partners/partner-rules.ts`). */
const emptyOr = (valid: (value: string) => boolean, message: string) => z.string().trim().refine((value) => value === "" || valid(value), message);

export const partnerFormSchema = z.object({
  name: z.string().trim().min(PARTNER_LIMITS.nameMin, "Как команда зовёт партнёра: «Канал „Игровой угол“»").max(PARTNER_LIMITS.nameMax, `Не длиннее ${String(PARTNER_LIMITS.nameMax)} знаков`),
  contact: z.string().trim().max(PARTNER_LIMITS.contactMax, `Не длиннее ${String(PARTNER_LIMITS.contactMax)} знаков`),
  note: z.string().trim().max(PARTNER_LIMITS.noteMax, `Не длиннее ${String(PARTNER_LIMITS.noteMax)} знаков`),
  telegramId: emptyOr((value) => /^[0-9]{1,20}$/.test(value), "TG id — число до 20 цифр"),
  country: emptyOr((value) => /^[A-Za-z]{2}$/.test(value), "Страна — две буквы, например KZ"),
  payoutCurrency: emptyOr((value) => (PAYOUT_CURRENCIES as readonly string[]).includes(value), "Валюта — из списка"),
  payoutMethod: z.string().trim().max(PARTNER_LIMITS.payoutMethodMax, `Не длиннее ${String(PARTNER_LIMITS.payoutMethodMax)} знаков`),
  sharePercent: emptyOr((value) => /^\d{1,3}(\.\d{1,2})?$/.test(value) && Number(value) <= 100, "Процент — от 0 до 100, не больше двух знаков после точки"),
});

export function emptyPartnerForm(): PartnerForm {
  return { name: "", contact: "", note: "", telegramId: "", country: "", payoutCurrency: "", payoutMethod: "", sharePercent: "" };
}

export function partnerFormOf(partner: Partner): PartnerForm {
  return {
    name: partner.name,
    contact: partner.contact ?? "",
    note: partner.note ?? "",
    telegramId: partner.telegramId ?? "",
    country: partner.country ?? "",
    payoutCurrency: partner.payoutCurrency ?? "",
    payoutMethod: partner.payoutMethod ?? "",
    sharePercent: partner.sharePercent ?? "",
  };
}

/** Тело запроса: пустое поле — `null` (стирает), страна — заглавными. Все поля названы всегда: форма показывает карточку целиком. */
function bodyOf(form: PartnerForm) {
  const optional = (value: string) => (value.trim() === "" ? null : value.trim());
  return {
    name: form.name.trim(),
    contact: optional(form.contact),
    note: optional(form.note),
    telegramId: optional(form.telegramId),
    country: optional(form.country)?.toUpperCase() ?? null,
    payoutCurrency: optional(form.payoutCurrency),
    payoutMethod: optional(form.payoutMethod),
    sharePercent: optional(form.sharePercent),
  };
}

export function fetchPartners(api: AdminApi): Promise<ApiResult<PartnerCatalog>> {
  return api.request("/partners", { schema: catalogSchema });
}

export function fetchPartner(api: AdminApi, partnerId: string): Promise<ApiResult<PartnerDetail>> {
  return api.request(`/partners/${encodeURIComponent(partnerId)}`, { schema: detailSchema });
}

/** Вехи игроков партнёра в одном срезе: те же, что в отчёте «Воронка», без разреза. */
const funnelCountsSchema = z.object({
  accounts: z.number(),
  entered: z.number(),
  appOpened: z.number(),
  firstRunStarted: z.number(),
  firstRunFinished: z.number(),
  runs2: z.number(),
  runs5: z.number(),
  returnedD1: z.number(),
  returnedD7: z.number(),
  firstPurchase: z.number(),
});
export type PartnerFunnelCounts = z.infer<typeof funnelCountsSchema>;

/**
 * Воронка игроков партнёра (Р96, T-0068): привязанные к нему за период по дате привязки — все вместе,
 * по ссылке или коду и по площадке. Вид источника, которого панель не знает, — ошибка разбора: молча
 * пустая таблица спрятала бы игроков.
 */
export const partnerFunnelSchema = z.object({
  from: z.string(),
  to: z.string(),
  total: funnelCountsSchema,
  sources: z.array(z.object({ via: z.enum(["link", "code"]), name: z.string().nullable(), ref: z.string().nullable(), counts: funnelCountsSchema })),
  platforms: z.array(z.object({ platform: z.string(), counts: funnelCountsSchema })),
});
export type PartnerFunnel = z.infer<typeof partnerFunnelSchema>;
export type PartnerFunnelSource = PartnerFunnel["sources"][number];

export function fetchPartnerFunnel(api: AdminApi, partnerId: string, period: Period): Promise<ApiResult<PartnerFunnel>> {
  return api.request(`/partners/${encodeURIComponent(partnerId)}/funnel`, { query: { from: period.from, to: period.to }, schema: partnerFunnelSchema });
}

/** Вехи партнёра — строкой отчёта «Воронка»: полосы и «где теряем» считаются теми же функциями, что на том экране. */
export function funnelRowOf(counts: PartnerFunnelCounts, label: string): FunnelRow {
  return { platform: "все", startKind: "все", startRef: label, startSource: null, ...counts };
}

/** Как назвать источник привязки: ссылка — кампания и код, код — название кампании промокода; удалённое называется честно. */
export function sourceTitle(source: Pick<PartnerFunnelSource, "via" | "name" | "ref">): string {
  if (source.via === "link") return source.name === null ? `ссылка ${source.ref ?? ""}`.trim() : `ссылка ${source.name} · ${source.ref ?? ""}`.replace(/ · $/, "");
  return source.name === null ? "код (кампании больше нет)" : `код «${source.name}»`;
}

export function createPartner(api: AdminApi, form: PartnerForm): Promise<ApiResult<Partner>> {
  return api.request("/partners", { method: "POST", body: bodyOf(form), schema: partnerSchema });
}

export function updatePartner(api: AdminApi, partnerId: string, form: PartnerForm): Promise<ApiResult<Partner>> {
  return api.request(`/partners/${encodeURIComponent(partnerId)}`, { method: "POST", body: bodyOf(form), schema: partnerSchema });
}

/** Сменить статус: причина обязательна, уходит в аудит. */
export function setPartnerStatus(api: AdminApi, partnerId: string, status: PartnerStatus, reason: string): Promise<ApiResult<Partner>> {
  return api.request(`/partners/${encodeURIComponent(partnerId)}/status`, { method: "PUT", body: { status, reason: reason.trim() }, schema: partnerSchema });
}

/** Фильтр списка по статусу: по умолчанию все, кроме отклонённых; «все» показывает и их. */
export type StatusFilter = "visible" | "all" | PartnerStatus;

export const STATUS_FILTERS: readonly (readonly [StatusFilter, string])[] = [
  ["visible", "Все, кроме отклонённых"],
  ["all", "Все"],
  ...PARTNER_STATUSES.map((status) => [status, STATUS_TITLES[status]] as const),
];

export function filterPartners<T extends { status: PartnerStatus }>(partners: readonly T[], filter: StatusFilter): T[] {
  if (filter === "all") return [...partners];
  if (filter === "visible") return partners.filter((partner) => partner.status !== "rejected");
  return partners.filter((partner) => partner.status === filter);
}

/** Партнёры для выбора в мастере ссылки: только активные, по алфавиту — ссылку неактивного партнёра никто не привяжет. */
export function activePartners(partners: readonly Pick<Partner, "partnerId" | "name" | "status">[]): { partnerId: string; name: string }[] {
  return partners
    .filter((partner) => bindsNewPlayers(partner.status))
    .map(({ partnerId, name }) => ({ partnerId, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

/** Доля от числа словами для таблицы: «12 · 40%»; от нуля — прочерк, а не «NaN%». */
export function share(part: number, whole: number): string {
  return whole === 0 ? "—" : `${String(Math.round((part / whole) * 100))}%`;
}

/** Маршрут мастера промокода с выбранным партнёром: `#/promo-codes/partner:<id>`. */
export const PARTNER_CODE_ROUTE = "partner:";

export function partnerOfRoute(id: string | null): string | null {
  return id !== null && id.startsWith(PARTNER_CODE_ROUTE) ? id.slice(PARTNER_CODE_ROUTE.length) : null;
}
