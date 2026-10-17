import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

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

export const NO_BINDING_NOTE = "Новые игроки к партнёру не привязываются";
export const NO_ACCRUAL_NOTE = "начисления — после модели учёта";

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

/** Доля от числа словами для таблицы: «12 · 40%»; от нуля — прочерк, а не «NaN%». */
export function share(part: number, whole: number): string {
  return whole === 0 ? "—" : `${String(Math.round((part / whole) * 100))}%`;
}

/** Маршрут мастера промокода с выбранным партнёром: `#/promo-codes/partner:<id>`. */
export const PARTNER_CODE_ROUTE = "partner:";

export function partnerOfRoute(id: string | null): string | null {
  return id !== null && id.startsWith(PARTNER_CODE_ROUTE) ? id.slice(PARTNER_CODE_ROUTE.length) : null;
}
