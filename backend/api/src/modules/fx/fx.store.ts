import { Inject, Injectable } from "@nestjs/common";
import {
  decimal,
  isCurrencyCode,
  MANUAL_RATE_PURPOSES,
  type CurrencyCode,
  type ManualRate,
  type ManualRatePurpose,
  type Quote,
  type Rate,
  type RateStore,
  type RatesSnapshot,
  type SourceState,
  type StoredRate,
} from "@bh/fx";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * Хранилище курсов на Postgres — порт `RateStore` ядра `packages/fx`
 * (docs/35-stage4-plan.md, §3.12). Совместимость с ядром держит контрактный
 * тест (`test/fx.integration.test.ts`), а не договорённость.
 *
 * `Decimal` ядра и `Decimal` Prisma — разные классы одной библиотеки, и через
 * границу они ходят строкой: `toFixed()` без аргументов — полная запись без
 * экспоненты, её Postgres и принимает без потерь.
 */

export const FX_STORE = Symbol("FX_STORE");

const rateJson = z.object({ usdPerUnit: z.string(), sources: z.array(z.string()), observedAt: z.string() });
const ratesJson = z.record(z.string(), rateJson);

@Injectable()
export class PrismaRateStore implements RateStore {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async latestQuotes(currency: CurrencyCode): Promise<Quote[]> {
    const rows = await this.prisma.fxQuote.findMany({ where: { currency } });
    return rows.map((row) => ({ currency, usdPerUnit: decimal(row.usdPerUnit.toFixed()), source: row.source, observedAt: row.observedAt }));
  }

  async saveQuotes(quotes: readonly Quote[]): Promise<void> {
    if (quotes.length === 0) return;
    const savedAt = new Date();
    // Одним запросом: у источника шесть валют, и шесть обращений к базе на
    // каждый опрос незачем.
    await this.prisma.$transaction(
      quotes.map((quote) =>
        this.prisma.fxQuote.upsert({
          where: { source_currency: { source: quote.source, currency: quote.currency } },
          create: { source: quote.source, currency: quote.currency, usdPerUnit: quote.usdPerUnit.toFixed(), observedAt: quote.observedAt, savedAt },
          update: { usdPerUnit: quote.usdPerUnit.toFixed(), observedAt: quote.observedAt, savedAt },
        }),
      ),
    );
  }

  async currentRate(currency: CurrencyCode): Promise<StoredRate | null> {
    const row = await this.prisma.fxRateCurrent.findUnique({ where: { currency } });
    if (row === null) return null;
    return { currency, usdPerUnit: decimal(row.usdPerUnit.toFixed()), sources: row.sources, observedAt: row.observedAt, acceptedAt: row.acceptedAt };
  }

  async setCurrentRate(rate: Rate, acceptedAt: Date): Promise<void> {
    const data = { usdPerUnit: rate.usdPerUnit.toFixed(), sources: [...rate.sources], observedAt: rate.observedAt, acceptedAt };
    await this.prisma.fxRateCurrent.upsert({ where: { currency: rate.currency }, create: { currency: rate.currency, ...data }, update: data });
  }

  async appendHistory(rate: Rate, acceptedAt: Date): Promise<void> {
    await this.prisma.fxRateHistory.create({
      data: { currency: rate.currency, usdPerUnit: rate.usdPerUnit.toFixed(), sources: [...rate.sources], observedAt: rate.observedAt, acceptedAt },
    });
  }

  async lastHistoryAt(currency: CurrencyCode): Promise<Date | null> {
    const row = await this.prisma.fxRateHistory.findFirst({ where: { currency }, orderBy: { acceptedAt: "desc" }, select: { acceptedAt: true } });
    return row?.acceptedAt ?? null;
  }

  async sourceState(source: string): Promise<SourceState | null> {
    const row = await this.prisma.fxSourceState.findUnique({ where: { source } });
    if (row === null) return null;
    return { usage: { month: row.month, used: row.used, pausedUntil: row.pausedUntil }, nextPollAt: row.nextPollAt };
  }

  async saveSourceState(source: string, state: SourceState): Promise<void> {
    const data = { month: state.usage.month, used: state.usage.used, pausedUntil: state.usage.pausedUntil, nextPollAt: state.nextPollAt };
    await this.prisma.fxSourceState.upsert({ where: { source }, create: { source, ...data }, update: data });
  }

  async currentManual(currency: CurrencyCode, purpose: ManualRatePurpose): Promise<ManualRate | null> {
    const row = await this.prisma.fxManualRate.findFirst({ where: { currency, purpose }, orderBy: { setAt: "desc" } });
    if (row === null) return null;
    // Котировка из базы — граница: незнакомая валюта значит, что строку писал
    // кто-то мимо ядра, и доверять такому курсу нельзя.
    if (!isCurrencyCode(row.quote)) return null;
    return { currency, purpose, price: decimal(row.price.toFixed()), quote: row.quote, setBy: row.setBy, setAt: row.setAt, expiresAt: row.expiresAt, note: row.note };
  }

  async appendManual(rate: ManualRate): Promise<void> {
    await this.prisma.fxManualRate.create({
      data: {
        currency: rate.currency,
        purpose: rate.purpose,
        price: rate.price.toFixed(),
        quote: rate.quote,
        setBy: rate.setBy,
        setAt: rate.setAt,
        expiresAt: rate.expiresAt,
        note: rate.note,
      },
    });
  }

  async saveSnapshot(snapshot: Omit<RatesSnapshot, "id">): Promise<RatesSnapshot> {
    const row = await this.prisma.fxSnapshot.create({
      data: { takenAt: snapshot.takenAt, rates: toJson(snapshot.rates), payout: toJson(snapshot.payout) },
      select: { id: true },
    });
    return { ...snapshot, id: row.id };
  }

  async snapshot(id: string): Promise<RatesSnapshot | null> {
    // Идентификатор снимка приходит и из платежа, и из запроса панели: не
    // uuid — такого снимка нет, а не ошибка базы.
    if (!z.string().uuid().safeParse(id).success) return null;
    const row = await this.prisma.fxSnapshot.findUnique({ where: { id } });
    if (row === null) return null;
    return { id: row.id, takenAt: row.takenAt, rates: fromJson(row.rates), payout: fromJson(row.payout) };
  }
}

export function isManualPurpose(value: string): value is ManualRatePurpose {
  return (MANUAL_RATE_PURPOSES as readonly string[]).includes(value);
}

function toJson(rates: ReadonlyMap<CurrencyCode, Rate>): Record<string, z.infer<typeof rateJson>> {
  return Object.fromEntries(
    [...rates].map(([code, rate]) => [code, { usdPerUnit: rate.usdPerUnit.toFixed(), sources: [...rate.sources], observedAt: rate.observedAt.toISOString() }]),
  );
}

/** JSON из базы — граница: разбирается схемой, незнакомая валюта отбрасывается. */
function fromJson(value: unknown): Map<CurrencyCode, Rate> {
  const parsed = ratesJson.parse(value);
  const rates = new Map<CurrencyCode, Rate>();
  for (const [code, rate] of Object.entries(parsed)) {
    if (!isCurrencyCode(code)) continue;
    rates.set(code, { currency: code, usdPerUnit: decimal(rate.usdPerUnit), sources: rate.sources, observedAt: new Date(rate.observedAt) });
  }
  return rates;
}
