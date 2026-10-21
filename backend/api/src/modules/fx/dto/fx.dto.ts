import { CURRENCIES, MANUAL_RATE_PURPOSES, type CurrencyCode } from "@bh/fx";
import { z } from "zod";

/**
 * Граница модуля курсов (docs/35-stage4-plan.md, §3.12). Курс приходит
 * строкой: число JSON прошло бы через двоичную дробь раньше, чем его увидит
 * `Decimal`.
 */

const platformCodes = (Object.keys(CURRENCIES) as CurrencyCode[]).filter((code) => CURRENCIES[code].kind === "platform");
// Котировка — только фиат: цена звезды для игрока держится в рублях по прайс-листу,
// выплата — в долларах; в крипте заданный курс звёзд смысла не имеет.
const quoteCodes = (Object.keys(CURRENCIES) as CurrencyCode[]).filter((code) => CURRENCIES[code].kind === "fiat");

export const manualRateSchema = z.object({
  currency: z.enum(platformCodes as [CurrencyCode, ...CurrencyCode[]]),
  purpose: z.enum(MANUAL_RATE_PURPOSES),
  price: z.string().regex(/^\d{1,12}(\.\d{1,40})?$/),
  quote: z.enum(quoteCodes as [CurrencyCode, ...CurrencyCode[]]).default("USD"),
  // Срок годности обязателен: заданный курс без него устаревал бы молча.
  expiresInDays: z.number().int().min(1).max(90),
  note: z.string().trim().min(3).max(200),
});

export type ManualRateBody = z.infer<typeof manualRateSchema>;

const MAX_REQUESTS = 100_000_000;
const noteSchema = z.string().trim().min(3).max(200);

// «Без лимита» — явный `null`, а не пропущенное поле: забытый ключ не должен
// молча снять лимит с источника.
export const sourceLimitSchema = z.object({
  perMonth: z.number().int().min(1).max(MAX_REQUESTS).nullable(),
  note: noteSchema,
});

export const sourceUsedSchema = z.object({
  used: z.number().int().min(0).max(MAX_REQUESTS),
  note: noteSchema,
});

export type SourceLimitBody = z.infer<typeof sourceLimitSchema>;
export type SourceUsedBody = z.infer<typeof sourceUsedSchema>;
