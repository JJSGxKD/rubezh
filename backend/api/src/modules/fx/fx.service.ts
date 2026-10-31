import { Inject, Injectable } from "@nestjs/common";
import {
  BASE_CURRENCY,
  CURRENCIES,
  Decimal,
  FRESHNESS_POLICY,
  freshness,
  manualRate,
  manualToRate,
  monthOf,
  nextPollDelayMs,
  takeSnapshot,
  type CurrencyCode,
  type Freshness,
  type ManualRate,
  type ManualRatePurpose,
  type RateSource,
  type RatesSnapshot,
} from "@bh/fx";
import { DomainError, ValidationError } from "../../common/domain-error.js";
import { SECRETS_READER, type SecretsReader } from "../secrets/secrets.service.js";
import { FeatureSwitches } from "../settings/feature-switches.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { effectiveTariff, usedShare } from "./fx-limits.js";
import { FxRefreshBusyError, FxRefreshLimitError, FxRefreshPausedError, FxRefresher, fxSources, type RefreshNowResult } from "./fx.refresher.js";
import { FX_STORE, type FxStore, type SourceLimit } from "./fx.store.js";

/**
 * Курсы для панели и для слоя цен (docs/35-stage4-plan.md, §3.12): обзор со
 * свежестью, заданные курсы валют площадок, снимок и лимиты источников
 * (Р89): остаток запросов, лимит из панели и правка счётчика.
 */

const DAY_MS = 86_400_000;

/** Источника с таким именем нет в коде — править в панели можно только то, что опрашивается. */
export class FxSourceNotFoundError extends DomainError {
  constructor() {
    super("fx_source_not_found", "Источника курсов с таким именем нет", 404);
  }
}

export type { RefreshNowResult };

/** «Обновить сейчас» отказано: тексты — из решения Р90, статус — как у соседних ошибок панели. */
export class FxRefreshRefusedError extends DomainError {
  constructor(code: string, message: string, status: number) {
    super(code, message, status);
  }
}

export interface RateView {
  currency: CurrencyCode;
  /** цена единицы в долларах и сколько единиц за доллар — строкой, без потерь */
  usdPerUnit: string;
  unitsPerUsd: string;
  sources: readonly string[];
  observedAt: string;
  freshness: Freshness;
}

export interface ManualView extends Omit<RateView, "usdPerUnit" | "unitsPerUsd"> {
  purpose: ManualRatePurpose;
  /** цена в валюте котировки — как её поставили */
  price: string;
  quote: CurrencyCode;
  /** она же в долларах по текущему курсу котировки; нет курса — `null` */
  usdPerUnit: string | null;
  setBy: string;
  expiresAt: string;
  note: string;
  /**
   * Курс рыночной валюты — запасной, и именно он сейчас в снимке: рыночного нет
   * или он просрочен. У валюты площадки и у запасного в простое — `false`.
   */
  fallback: boolean;
}

export interface SourceView {
  source: string;
  /** имя тарифа из кода; лимит из панели его не меняет */
  tariff: string;
  /** месяц счётчика `ГГГГ-ММ` по UTC; `null` — источник ещё не опрашивали */
  month: string | null;
  /** запросов в текущем месяце: с новым месяцем счётчик начинается с нуля */
  used: number;
  pausedUntil: string | null;
  nextPollAt: string | null;
  /** месячный лимит и откуда он: тариф из кода или панель */
  limit: { perMonth: number | null; from: "tariff" | "panel" };
  /** доля лимита; без лимита — `null`, сверх лимита — больше единицы */
  usedShare: number | null;
}

export interface FxOverview {
  enabled: boolean;
  rates: RateView[];
  missing: CurrencyCode[];
  manual: ManualView[];
  sources: SourceView[];
}

export interface ManualInput {
  currency: CurrencyCode;
  purpose: ManualRatePurpose;
  /** цена единицы в валюте котировки */
  price: string;
  quote: CurrencyCode;
  expiresInDays: number;
  note: string;
}

@Injectable()
export class FxService {
  constructor(
    @Inject(FX_STORE) private readonly store: FxStore,
    @Inject(SECRETS_READER) private readonly secrets: SecretsReader,
    private readonly roles: RolesService,
    private readonly switches: FeatureSwitches,
    // Только «Обновить сейчас»; проход по расписанию сервису не нужен.
    @Inject(FxRefresher) private readonly refresher: Pick<FxRefresher, "refreshNow">,
  ) {}

  async overview(now = new Date()): Promise<FxOverview> {
    const rates: RateView[] = [];
    const missing: CurrencyCode[] = [];
    const manual: ManualView[] = [];
    for (const code of Object.keys(CURRENCIES) as CurrencyCode[]) {
      if (code === BASE_CURRENCY) continue;
      const kind = CURRENCIES[code].kind;
      if (kind !== "platform") {
        const rate = await this.store.currentRate(code);
        if (rate === null) missing.push(code);
        else rates.push({ ...view(code, rate.usdPerUnit, rate.sources, rate.observedAt), freshness: freshness(rate.observedAt, now, FRESHNESS_POLICY[kind]) });
        continue;
      }
      for (const purpose of ["price", "payout"] as const) {
        const rate = await this.store.currentManual(code, purpose);
        if (rate === null) continue;
        manual.push(await this.manualView(rate, now));
      }
    }
    // Запасные ручные курсы рыночных валют (Р90): в списке заданных, с меткой «в работе».
    for (const code of Object.keys(CURRENCIES) as CurrencyCode[]) {
      if (code === BASE_CURRENCY || CURRENCIES[code].kind === "platform") continue;
      const reserve = await this.store.currentManual(code, "price");
      if (reserve !== null) manual.push(await this.manualView(reserve, now));
    }

    const limits = await this.store.limits();
    const sources: SourceView[] = [];
    for (const source of fxSources(this.secrets)) sources.push(await this.sourceView(source, limits.get(source.id), now));
    return { enabled: this.switches.fxPolling(), rates, missing, manual, sources };
  }

  /** Источник для панели: счётчик месяца, лимит и его происхождение. */
  private async sourceView(source: RateSource, override: SourceLimit | undefined, now: Date): Promise<SourceView> {
    const state = await this.store.sourceState(source.id);
    const month = monthOf(now);
    // Счётчик прошлого месяца в новом — ноль, как и считает ядро.
    const used = state?.usage.month === month ? state.usage.used : 0;
    const limit = limitState(source, override);
    return {
      source: source.id,
      tariff: source.tariff.name,
      month: state === null ? null : month,
      used,
      pausedUntil: state?.usage.pausedUntil?.toISOString() ?? null,
      nextPollAt: state?.nextPollAt.toISOString() ?? null,
      limit,
      usedShare: usedShare(used, limit.perMonth),
    };
  }

  /**
   * Лимит источника в месяц (Р89): запросов в календарный месяц UTC или
   * `null` — «без лимита». Под правом, с причиной и записью в аудит «было →
   * стало»; со следующего прохода опросы идут по новому лимиту.
   */
  async setLimit(actor: AccountRef, source: string, perMonth: number | null, note: string, now = new Date()): Promise<SourceView> {
    await this.roles.require(actor, "fx.rates.edit");
    const known = this.sourceOf(source);
    const before = (await this.store.limits()).get(source);
    await this.store.setLimit(source, perMonth, note, actor.accountId, now);
    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: "fx.limit.set",
      target: source,
      before: limitState(known, before),
      after: { perMonth, from: "panel", note },
    });
    return await this.afterEdit(known, now);
  }

  /** Сброс к тарифу из кода. Строки в панели не было — сбрасывать нечего, в журнал это не идёт. */
  async resetLimit(actor: AccountRef, source: string, now = new Date()): Promise<SourceView> {
    await this.roles.require(actor, "fx.rates.edit");
    const known = this.sourceOf(source);
    const before = (await this.store.limits()).get(source);
    if (before !== undefined) {
      await this.store.resetLimit(source);
      await this.roles.audit({
        actorAccountId: actor.accountId,
        action: "fx.limit.reset",
        target: source,
        before: limitState(known, before),
        after: limitState(known, undefined),
      });
    }
    return await this.afterEdit(known, now);
  }

  /**
   * Поправить счётчик, когда он разошёлся с кабинетом поставщика: новое
   * значение за текущий месяц, причина — в аудит. С новым месяцем счётчик, как
   * и раньше, начинается с нуля.
   */
  async correctUsed(actor: AccountRef, source: string, used: number, note: string, now = new Date()): Promise<SourceView> {
    await this.roles.require(actor, "fx.rates.edit");
    const known = this.sourceOf(source);
    const month = monthOf(now);
    const state = await this.store.sourceState(source);
    await this.store.setUsed(source, used, month, now);
    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: "fx.used.correct",
      target: source,
      before: { month, used: state?.usage.month === month ? state.usage.used : 0 },
      after: { month, used, note },
    });
    return await this.afterEdit(known, now);
  }

  /**
   * «Обновить сейчас» (Р90, T-0064): источник спрашивается сразу, в пределах
   * лимитов, под общим локом; в аудит — источник и исход. Отказы — лимит 409,
   * пауза 429 с секундами, занято 409; в аудит они не идут: ничего не менялось.
   */
  async refreshNow(actor: AccountRef, source: string, now = new Date()): Promise<RefreshNowResult> {
    await this.roles.require(actor, "fx.rates.edit");
    const known = this.sourceOf(source);
    let result: RefreshNowResult;
    try {
      result = await this.refresher.refreshNow(known.id, now);
    } catch (error: unknown) {
      if (error instanceof FxRefreshLimitError) throw new FxRefreshRefusedError("fx_refresh_limit", "Лимит источника на месяц исчерпан", 409);
      if (error instanceof FxRefreshPausedError) throw new FxRefreshRefusedError("fx_refresh_too_soon", `Источник спрашивали только что — повторите через ${String(error.seconds)} с`, 429);
      if (error instanceof FxRefreshBusyError) throw new FxRefreshRefusedError("fx_refresh_busy", "Идёт обновление по расписанию, повторите через минуту", 409);
      throw error;
    }
    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: "fx.refresh.now",
      target: source,
      after: { ok: result.ok, error: result.error, quotes: result.quotes.map((quote) => ({ currency: quote.currency, status: quote.status })) },
    });
    return result;
  }

  private sourceOf(id: string): RateSource {
    const source = fxSources(this.secrets).find((candidate) => candidate.id === id);
    if (source === undefined) throw new FxSourceNotFoundError();
    return source;
  }

  /**
   * После правки ближайший опрос мог устареть: у исчерпанного источника он
   * стоит на начале следующего месяца, и поднятый лимит иначе заработал бы
   * только тогда. Срок пересчитывается по новым числам и только
   * приближается — правка опрос не откладывает.
   */
  private async afterEdit(source: RateSource, now: Date): Promise<SourceView> {
    const override = (await this.store.limits()).get(source.id);
    const state = await this.store.sourceState(source.id);
    if (state !== null) {
      const at = new Date(now.getTime() + nextPollDelayMs(effectiveTariff(source.tariff, override), state.usage, now));
      if (at < state.nextPollAt) await this.store.pullPollForward(source.id, at);
    }
    return await this.sourceView(source, override, now);
  }

  /**
   * Заданный курс валюты площадки (§3.12): под правом, с причиной, сроком
   * годности и записью в аудит. У рыночной валюты ручной курс запасной
   * (Р90): в долларах, на цену, не дольше недели — и работает, только пока
   * источники не дают свежего, а не перебивает медиану.
   */
  async setManual(actor: AccountRef, input: ManualInput, now = new Date()): Promise<ManualView> {
    await this.roles.require(actor, "fx.rates.edit");
    let rate: ManualRate;
    try {
      rate = manualRate({
        currency: input.currency,
        purpose: input.purpose,
        price: input.price,
        quote: input.quote,
        setBy: actor.accountId,
        setAt: now,
        expiresAt: new Date(now.getTime() + input.expiresInDays * DAY_MS),
        note: input.note,
      });
    } catch (error: unknown) {
      if (error instanceof RangeError) throw new ValidationError(error.message);
      throw error;
    }

    const before = await this.store.currentManual(input.currency, input.purpose);
    await this.store.appendManual(rate);
    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: "fx.manual_rate",
      target: `${input.currency}:${input.purpose}`,
      before: before === null ? null : { price: before.price.toFixed(), quote: before.quote, expiresAt: before.expiresAt.toISOString() },
      after: { price: rate.price.toFixed(), quote: rate.quote, expiresAt: rate.expiresAt.toISOString(), note: rate.note },
    });
    return await this.manualView(rate, now);
  }

  /** Заданный курс для панели: как поставили и сколько это в долларах сейчас. */
  private async manualView(rate: ManualRate, now: Date): Promise<ManualView> {
    const kind = CURRENCIES[rate.currency].kind;
    const market = kind === "platform" ? null : await this.store.currentRate(rate.currency);
    const fallback = kind !== "platform" && (market === null || freshness(market.observedAt, now, FRESHNESS_POLICY[kind]) === "expired") && rate.expiresAt >= now;
    const quoteUsd = rate.quote === BASE_CURRENCY ? new Decimal(1) : (await this.store.currentRate(rate.quote))?.usdPerUnit;
    return {
      currency: rate.currency,
      purpose: rate.purpose,
      price: rate.price.toFixed(),
      quote: rate.quote,
      usdPerUnit: quoteUsd === undefined ? null : manualToRate(rate, quoteUsd).usdPerUnit.toSignificantDigits(12).toFixed(),
      sources: [`manual:${rate.setBy}`],
      observedAt: rate.setAt.toISOString(),
      freshness: freshness(rate.expiresAt, now, FRESHNESS_POLICY.platform),
      setBy: rate.setBy,
      expiresAt: rate.expiresAt.toISOString(),
      note: rate.note,
      fallback,
    };
  }

  /** Снимок на сейчас — на него сошлются цена и платёж (часть 3 WP9). */
  async snapshot(now = new Date()): Promise<RatesSnapshot> {
    return await takeSnapshot(this.store, now);
  }
}

/** Месячный лимит источника и откуда он: строка в панели или тариф из кода. */
function limitState(source: RateSource, override: SourceLimit | undefined): SourceView["limit"] {
  return { perMonth: effectiveTariff(source.tariff, override).perMonth, from: override === undefined ? "tariff" : "panel" };
}

function view(currency: CurrencyCode, usdPerUnit: Decimal, sources: readonly string[], observedAt: Date): Omit<RateView, "freshness"> {
  return {
    currency,
    usdPerUnit: usdPerUnit.toFixed(),
    unitsPerUsd: new Decimal(1).div(usdPerUnit).toSignificantDigits(12).toFixed(),
    sources,
    observedAt: observedAt.toISOString(),
  };
}
