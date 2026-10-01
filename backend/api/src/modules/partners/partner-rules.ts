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

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => (value === null || value === "" ? null : value));

export const partnerInputSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    /** как связаться: @имя, ссылка, почта */
    contact: optionalText(120),
    note: optionalText(500),
  })
  .strict();

export type PartnerInput = z.infer<typeof partnerInputSchema>;

export interface PartnerRow {
  partnerId: string;
  name: string;
  contact: string | null;
  note: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

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
