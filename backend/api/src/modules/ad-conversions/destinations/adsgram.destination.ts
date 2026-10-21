import { SECRETS } from "../../secrets/secret-catalog.js";
import type { SecretsReader } from "../../secrets/secrets.service.js";
import { NO_TOKEN_RECHECK_MIN, adsgramPostbackUrl, redacted } from "../conversion-rules.js";
import type { DueConversion } from "../conversions.repository.js";
import { EVENT_GOAL, type PostbackEvent } from "../postback-events.js";
import { UNKNOWN_DESTINATION_REASON, type PostbackDestination, type Prepared } from "./destination.js";

/**
 * AdsGram (docs/35-stage4-plan.md Р86, WP43): три фиксированных события —
 * `goaltype` 1–3. Возврат на следующий день сеть не получает никогда.
 */
const ADSGRAM_EVENTS = ["registration", "purchase_first", "purchase_repeat"] as const satisfies readonly PostbackEvent[];
type AdsgramEvent = (typeof ADSGRAM_EVENTS)[number];

function isAdsgramEvent(event: PostbackEvent): event is AdsgramEvent {
  return ADSGRAM_EVENTS.some((known) => known === event);
}

export class AdsgramDestination implements PostbackDestination {
  readonly kind = "adsgram";
  readonly accepts: readonly PostbackEvent[] = ADSGRAM_EVENTS;

  constructor(private readonly secrets: SecretsReader) {}

  async prepare(conversion: DueConversion): Promise<Prepared> {
    if (!isAdsgramEvent(conversion.event)) return { kind: "skip", reason: UNKNOWN_DESTINATION_REASON };
    const token = this.secrets.get(SECRETS.adsgramConversionToken);
    if (token === null) return { kind: "wait", reason: "no_token", recheckMin: NO_TOKEN_RECHECK_MIN };
    const url = adsgramPostbackUrl(token, { goal: EVENT_GOAL[conversion.event], params: conversion.params, telegramId: conversion.telegramId });
    if (url === null) return { kind: "skip", reason: "no_macros" };
    return { kind: "request", url, logUrl: redacted(url) };
  }
}
