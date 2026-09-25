import { CURRENCIES, MANUAL_RATE_PURPOSES, type CurrencyCode } from "@bh/fx";
import { z } from "zod";

/**
 * Граница модуля курсов (docs/35-stage4-plan.md, §3.12). Курс приходит
 * строкой: число JSON прошло бы через двоичную дробь раньше, чем его увидит
 * `Decimal`.
 */

const platformCodes = (Object.keys(CURRENCIES) as CurrencyCode[]).filter((code) => CURRENCIES[code].kind === "platform");

export const manualRateSchema = z.object({
  currency: z.enum(platformCodes as [CurrencyCode, ...CurrencyCode[]]),
  purpose: z.enum(MANUAL_RATE_PURPOSES),
  usdPerUnit: z.string().regex(/^\d{1,12}(\.\d{1,40})?$/),
  // Срок годности обязателен: заданный курс без него устаревал бы молча.
  expiresInDays: z.number().int().min(1).max(90),
  note: z.string().trim().min(3).max(200),
});

export type ManualRateBody = z.infer<typeof manualRateSchema>;
