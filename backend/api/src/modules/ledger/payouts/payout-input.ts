import { z } from "zod";
import { PAYEE_PATTERN } from "./payee.js";

/**
 * Поля операции «выплата» (docs/37-accounting.md §13, Р222, tasks/T-0469): кому, за какой месяц отчёта, с какого места
 * и сколько. Общие поля вида (причина, ссылка, снимок чека, дата) добавляет `operation-input.ts`. Схема тела строгая,
 * как у остальных видов; правила «можно ли платить» — не схемы, а сборщика (`payout-rules.ts`): им нужны данные месяца.
 */

/** Причина решения владельца — как причина операции: короче трёх знаков отписка, длиннее пятисот не влезает в колонку. */
export const OVERRIDE_REASON_MIN = 3;
export const OVERRIDE_REASON_MAX = 500;

export const payoutFields = {
  /** `stakeholder:<аккаунт>`, `owner`, `tax` или `loan:<заём>` */
  payee: z.string().regex(PAYEE_PATTERN),
  /** месяц отчёта, за который платят: «ГГГГ-ММ» */
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),
  /** счёт места хранения, с которого платят */
  from: z.string().regex(/^[a-z0-9._-]{1,64}$/u),
  /** десятичная строка в валюте места: «15980.40» */
  amount: z.string().regex(/^\d{1,18}(\.\d{1,18})?$/u),
  /** решение владельца: участник молчит дольше срока или оспорил отчёт */
  overrideReason: z.string().trim().min(OVERRIDE_REASON_MIN).max(OVERRIDE_REASON_MAX).optional(),
};
