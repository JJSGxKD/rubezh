import { isCurrencyCode } from "@bh/fx";
import { z } from "zod";

/**
 * Партнёры (docs/35-stage4-plan.md WP41, часть 2; docs/23-referral-and-partner-program.md §3–§5).
 *
 * Партнёр — блогер, канал, сообщество — приводит игроков своими
 * промокодами. Активация его кода даёт награду кода и, если игрок новый и
 * ещё ни к кому не привязан, записывает его за партнёром. Старый игрок,
 * узнавший код из поста, награду получит, но приведённым не считается: его
 * привёл не этот пост.
 */
export const PARTNER_RULES = {
  /** привязать к партнёру можно аккаунт не старше стольких суток — гипотеза §3, рабочее */
  bindWindowDays: 7,
} as const;

/**
 * Статус партнёра (docs/35-stage4-plan.md Р96): заявка, активен, приостановлен,
 * отклонён. Он решает одно — привязывает ли партнёр новых игроков.
 */
export const PARTNER_STATUSES = ["applied", "active", "paused", "rejected"] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

/**
 * Новых игроков к партнёру привязывает только активный. Код партнёра в любом
 * другом статусе даёт свою награду, но игрока за партнёром не записывает;
 * привязанные раньше остаются за ним при любом статусе — смена статуса
 * приведённых не отнимает.
 */
export function bindsNewPlayers(status: PartnerStatus): boolean {
  return status === "active";
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => (value === null || value === "" ? null : value));

/**
 * Необязательное поле условий, проверяемое шаблоном: пустая строка и `null` —
 * `null`. Не названное в теле не появляется вовсе, поэтому правка без этих
 * полей ничего не стирает — стирает только явный `null` или пустая строка.
 */
const optionalTerm = (valid: (value: string) => boolean, message: string) =>
  z
    .string()
    .trim()
    .refine((value) => value === "" || valid(value), message)
    .nullable()
    .transform((value) => (value === null || value === "" ? null : value))
    .optional();

/** Процент строкой, как в базе: «12.5» → «12.50». Строка, а не число: десятичная доля не должна пройти через двоичную дробь. */
const sharePercent = z
  .string()
  .trim()
  .refine((value) => value === "" || (/^\d{1,3}(\.\d{1,2})?$/.test(value) && Number(value) <= 100), "Процент — от 0 до 100, не больше двух знаков после точки")
  .nullable()
  .transform((value) => (value === null || value === "" ? null : Number(value).toFixed(2)))
  .optional();

export const partnerInputSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    /** как связаться: @имя, ссылка, почта */
    contact: optionalText(120),
    note: optionalText(500),
    /** Telegram ID партнёра — для будущего входа в его кабинет; уникален среди партнёров */
    telegramId: optionalTerm((value) => /^[0-9]{1,20}$/.test(value), "TG id — число до 20 цифр"),
    /** где партнёр получает выплаты — ISO-код из двух заглавных букв */
    country: optionalTerm((value) => /^[A-Z]{2}$/.test(value), "Страна — две заглавные буквы, например KZ"),
    /** в чём получает — код валюты из ядра курсов */
    payoutCurrency: optionalTerm(isCurrencyCode, "Валюта — код из списка курсов"),
    /** реквизиты словами: «USDT TRC-20 на …», «карта Тинькофф» */
    payoutMethod: optionalText(200).optional(),
    sharePercent,
  })
  .strict();

export type PartnerInput = z.infer<typeof partnerInputSchema>;

/** Условия партнёра: что записано в карточке сверх имени и связи (Р96). */
export interface PartnerTerms {
  telegramId: string | null;
  status: PartnerStatus;
  country: string | null;
  payoutCurrency: string | null;
  payoutMethod: string | null;
  /** процент строкой с двумя знаками: «12.50» */
  sharePercent: string | null;
}

/**
 * Строка партнёра. Условия у строки из базы заданы всегда; необязательны они в
 * типе только затем, чтобы строку можно было собрать без них (`termsOf` дополнит
 * умолчаниями) — так работают тесты, написанные до условий.
 */
export interface PartnerRow extends Partial<PartnerTerms> {
  partnerId: string;
  name: string;
  contact: string | null;
  note: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Строка партнёра с условиями целиком: без заданных — умолчания (`active`, остальное пусто). */
export type PartnerFull = PartnerRow & PartnerTerms;

export function termsOf(row: PartnerRow): PartnerTerms {
  return {
    telegramId: row.telegramId ?? null,
    status: row.status ?? "active",
    country: row.country ?? null,
    payoutCurrency: row.payoutCurrency ?? null,
    payoutMethod: row.payoutMethod ?? null,
    sharePercent: row.sharePercent ?? null,
  };
}

export function withTerms<T extends PartnerRow>(row: T): T & PartnerTerms {
  return { ...row, ...termsOf(row) };
}

/** Правка партнёра: название, связь и условия — то, что названо; статус — той же правкой, но только из `setStatus`. */
export type PartnerPatch = Partial<PartnerInput> & { status?: PartnerStatus };

/** Что партнёр принёс — для списка и карточки. Платящие и звёзды — живые оплаты после привязки, без возвращённых. */
export interface PartnerStats {
  /** кампаний с его кодом / из них действующих сейчас */
  codes: number;
  activeCodes: number;
  /** активаций его кодов — включая старых игроков, не привязанных к нему */
  redeemed: number;
  /** привязанных к нему игроков */
  bound: number;
  /** из них сыграли хотя бы один забег */
  played: number;
  /** из них платили после привязки */
  payers: number;
  /** сколько звёзд они заплатили после привязки */
  stars: number;
}

/** Можно ли привязать игрока такого возраста к партнёру. */
export function withinBindWindow(accountCreatedAt: Date, at: Date): boolean {
  return at.getTime() - accountCreatedAt.getTime() <= PARTNER_RULES.bindWindowDays * 86_400_000;
}
