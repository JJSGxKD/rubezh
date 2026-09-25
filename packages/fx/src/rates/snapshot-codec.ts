import { z } from "zod";
import { CURRENCY_CODES, REFERENCE_CURRENCY, type CurrencyCode } from "../currency.js";
import { Decimal } from "../decimal.js";
import type { RateSnapshot, SnapshotQuote } from "./snapshot.js";

/**
 * Снимок в JSON и обратно. Курсы — строками: число JSON прошло бы через
 * float и потеряло бы знаки. Разбор — Zod-схемой: снимок из Redis или из
 * колонки JSON — данные с границы, а не свои (docs/15-engineering-standards.md §5.1).
 */
const decimalText = z.string().transform((text, ctx) => {
  try {
    return Decimal.parse(text);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
    return z.NEVER;
  }
});

const quoteSchema = z.object({
  usdPerUnit: decimalText,
  revenueUsdPerUnit: decimalText,
  stale: z.boolean(),
  acceptedAt: z.number().int(),
  sources: z.array(z.string()),
});

const snapshotSchema = z.object({
  id: z.string().min(1),
  at: z.number().int(),
  reference: z.literal(REFERENCE_CURRENCY),
  // partialRecord: в снимке не обязаны быть все валюты реестра — record с enum-ключами в Zod 4 потребовал бы каждую.
  quotes: z.partialRecord(z.enum(CURRENCY_CODES), quoteSchema),
});

export function serializeSnapshot(snapshot: RateSnapshot): string {
  const quotes: Record<string, unknown> = {};
  for (const [code, quote] of Object.entries(snapshot.quotes) as Array<[CurrencyCode, SnapshotQuote]>) {
    quotes[code] = { ...quote, usdPerUnit: quote.usdPerUnit.toString(), revenueUsdPerUnit: quote.revenueUsdPerUnit.toString(), sources: [...quote.sources] };
  }
  return JSON.stringify({ id: snapshot.id, at: snapshot.at, reference: snapshot.reference, quotes });
}

export function parseSnapshot(text: string): RateSnapshot {
  const parsed = snapshotSchema.parse(JSON.parse(text));
  const quotes: Partial<Record<CurrencyCode, SnapshotQuote>> = {};
  for (const [code, quote] of Object.entries(parsed.quotes) as Array<[CurrencyCode, SnapshotQuote]>) quotes[code] = quote;
  return { id: parsed.id, at: parsed.at, reference: parsed.reference, quotes };
}

/** Глубокая копия через кодек — так же, как снимок пройдёт через базу. */
export function cloneSnapshot(snapshot: RateSnapshot): RateSnapshot {
  return parseSnapshot(serializeSnapshot(snapshot));
}
