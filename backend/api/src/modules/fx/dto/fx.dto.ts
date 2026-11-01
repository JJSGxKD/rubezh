import { BASE_CURRENCY, CURRENCIES, MANUAL_RATE_PURPOSES, MARKET_MANUAL_MAX_DAYS, MARKET_MANUAL_RULE, type CurrencyCode } from "@bh/fx";
import { z } from "zod";

/**
 * Граница модуля курсов (docs/35-stage4-plan.md, §3.12). Курс приходит
 * строкой: число JSON прошло бы через двоичную дробь раньше, чем его увидит
 * `Decimal`.
 */

// Ручной курс — любой валюте, кроме опорной (Р90): у валюты площадки он основной,
// у рыночной — запасной.
const manualCodes = (Object.keys(CURRENCIES) as CurrencyCode[]).filter((code) => code !== BASE_CURRENCY);
// Котировка — только фиат: цена звезды для игрока держится в рублях по прайс-листу,
// выплата — в долларах; в крипте заданный курс звёзд смысла не имеет.
const quoteCodes = (Object.keys(CURRENCIES) as CurrencyCode[]).filter((code) => CURRENCIES[code].kind === "fiat");

export const manualRateSchema = z
  .object({
    currency: z.enum(manualCodes as [CurrencyCode, ...CurrencyCode[]]),
    purpose: z.enum(MANUAL_RATE_PURPOSES),
    price: z.string().regex(/^\d{1,12}(\.\d{1,40})?$/),
    quote: z.enum(quoteCodes as [CurrencyCode, ...CurrencyCode[]]).default("USD"),
    // Срок годности обязателен: заданный курс без него устаревал бы молча.
    expiresInDays: z.number().int().min(1).max(90),
    note: z.string().trim().min(3).max(200),
  })
  .superRefine((body, context) => {
    if (CURRENCIES[body.currency].kind === "platform") return;
    // Запасной курс рыночной валюты: в долларах, на цену, на неделю (docs/35-stage4-plan.md Р90).
    if (body.quote !== BASE_CURRENCY || body.purpose !== "price") context.addIssue({ code: "custom", message: MARKET_MANUAL_RULE, path: ["currency"] });
    if (body.expiresInDays > MARKET_MANUAL_MAX_DAYS) context.addIssue({ code: "custom", message: `Запасной курс — не дольше ${String(MARKET_MANUAL_MAX_DAYS)} дней`, path: ["expiresInDays"] });
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
