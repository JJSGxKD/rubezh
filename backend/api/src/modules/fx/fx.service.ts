import { Inject, Injectable } from "@nestjs/common";
import {
  BASE_CURRENCY,
  CURRENCIES,
  Decimal,
  FRESHNESS_POLICY,
  freshness,
  manualRate,
  takeSnapshot,
  type CurrencyCode,
  type Freshness,
  type ManualRate,
  type ManualRatePurpose,
  type RateStore,
  type RatesSnapshot,
} from "@bh/fx";
import { ValidationError } from "../../common/domain-error.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { fxSources } from "./fx.refresher.js";
import { FX_STORE } from "./fx.store.js";

/**
 * Курсы для панели и для слоя цен (docs/35-stage4-plan.md, §3.12): обзор со
 * свежестью, заданные курсы валют площадок и снимок.
 */

const DAY_MS = 86_400_000;

export interface RateView {
  currency: CurrencyCode;
  /** цена единицы в долларах и сколько единиц за доллар — строкой, без потерь */
  usdPerUnit: string;
  unitsPerUsd: string;
  sources: readonly string[];
  observedAt: string;
  freshness: Freshness;
}

export interface ManualView extends RateView {
  purpose: ManualRatePurpose;
  setBy: string;
  expiresAt: string;
  note: string;
}

export interface SourceView {
  source: string;
  tariff: string;
  month: string | null;
  used: number;
  pausedUntil: string | null;
  nextPollAt: string | null;
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
  usdPerUnit: string;
  expiresInDays: number;
  note: string;
}

@Injectable()
export class FxService {
  constructor(
    @Inject(FX_STORE) private readonly store: RateStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly roles: RolesService,
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
        manual.push({
          ...view(code, rate.usdPerUnit, [`manual:${rate.setBy}`], rate.setAt),
          freshness: freshness(rate.expiresAt, now, FRESHNESS_POLICY.platform),
          purpose,
          setBy: rate.setBy,
          expiresAt: rate.expiresAt.toISOString(),
          note: rate.note,
        });
      }
    }

    const sources: SourceView[] = [];
    for (const source of fxSources(this.config)) {
      const state = await this.store.sourceState(source.id);
      sources.push({
        source: source.id,
        tariff: source.tariff.name,
        month: state?.usage.month ?? null,
        used: state?.usage.used ?? 0,
        pausedUntil: state?.usage.pausedUntil?.toISOString() ?? null,
        nextPollAt: state?.nextPollAt.toISOString() ?? null,
      });
    }
    return { enabled: this.config.fx.enabled, rates, missing, manual, sources };
  }

  /**
   * Заданный курс валюты площадки (§3.12): под правом, с причиной, сроком
   * годности и записью в аудит. Курс рыночной валюты руками не ставится —
   * иначе ручная правка тихо перебивала бы медиану источников.
   */
  async setManual(actor: AccountRef, input: ManualInput, now = new Date()): Promise<ManualView> {
    await this.roles.require(actor, "fx.rates.edit");
    if (CURRENCIES[input.currency].kind !== "platform") throw new ValidationError("Руками задаётся курс только валюты площадки");

    let rate: ManualRate;
    try {
      rate = manualRate({
        currency: input.currency,
        purpose: input.purpose,
        usdPerUnit: input.usdPerUnit,
        setBy: actor.accountId,
        setAt: now,
        expiresAt: new Date(now.getTime() + input.expiresInDays * DAY_MS),
        note: input.note,
      });
    } catch (error: unknown) {
      if (error instanceof RangeError) throw new ValidationError("Курс — число больше нуля");
      throw error;
    }

    const before = await this.store.currentManual(input.currency, input.purpose);
    await this.store.appendManual(rate);
    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: "fx.manual_rate",
      target: `${input.currency}:${input.purpose}`,
      before: before === null ? null : { usdPerUnit: before.usdPerUnit.toFixed(), expiresAt: before.expiresAt.toISOString() },
      after: { usdPerUnit: rate.usdPerUnit.toFixed(), expiresAt: rate.expiresAt.toISOString(), note: rate.note },
    });
    return {
      ...view(rate.currency, rate.usdPerUnit, [`manual:${rate.setBy}`], rate.setAt),
      freshness: "fresh",
      purpose: rate.purpose,
      setBy: rate.setBy,
      expiresAt: rate.expiresAt.toISOString(),
      note: rate.note,
    };
  }

  /** Снимок на сейчас — на него сошлются цена и платёж (часть 3 WP9). */
  async snapshot(now = new Date()): Promise<RatesSnapshot> {
    return await takeSnapshot(this.store, now);
  }
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
