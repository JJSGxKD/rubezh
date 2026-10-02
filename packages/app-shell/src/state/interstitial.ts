import type { AdShowOutcome } from "@bh/shared-types";
import { browserDeps, requestOf, showCreativeOffer, type AdTrackFields, type AdWatchDeps } from "./ad-watch";
import { passSession, type InterstitialMoment } from "./ads-api";

/**
 * Межстраничная при старте забега (docs/35-stage4-plan.md WP12, часть 10,
 * Р79): «Играть» или «Ещё раз» — естественная пауза, а не прерванный бой.
 * Показывать ли, решает сервер вместе с выдачей: новичок, VIP, пауза после
 * покупки или ролика, каждый N-й забег, доля флага выката. Клиент только
 * спрашивает и показывает.
 *
 * Старт забега ждёт её не дольше `INTERSTITIAL_WAIT_MS` — на выдачу и
 * подготовку показа вместе: отказ сети забег не задерживает. Попытка одна:
 * вторая сеть подряд — это уже ожидание, которого игрок не заказывал.
 *
 * Модуль грузится своим чанком при первом старте забега — первой загрузке он
 * не нужен.
 */

/** Сколько старт забега ждёт межстраничную, пока она не на экране. */
export const INTERSTITIAL_WAIT_MS = 2_000;

/** `shown` — реклама была на экране; `skipped` — не было: не время, нет рекламы, не успела. */
export type InterstitialResult = "shown" | "skipped";

export async function interstitialBeforeRun(moment: InterstitialMoment, alive: () => boolean = () => true, deps: AdWatchDeps = browserDeps()): Promise<InterstitialResult> {
  const startedAt = deps.now();
  const deadline = startedAt + INTERSTITIAL_WAIT_MS;
  const offered = deps.ads.offer("interstitial", deps.viewer, moment);
  const response = await Promise.race([offered, deps.sleep(INTERSTITIAL_WAIT_MS).then(() => null)]);
  if (response === null) {
    // Выдача опоздала — забег уже идёт. Выданную позже сессию закрываем
    // отказом: воронка видит опоздание, а сеть уходит на паузу места.
    void offered.then((late) => {
      if (late.ok && late.data.available && passSession(late.data) === null) giveUp(late.data.sessionId, { place: "interstitial", network: late.data.network, moment }, deps, startedAt);
    });
    return "skipped";
  }
  if (!response.ok || !response.data.available || passSession(response.data) !== null) return "skipped";
  const offer = response.data;
  const fields: AdTrackFields = { place: "interstitial", network: offer.network, moment };
  const left = deadline - deps.now();
  // Игрок ушёл в меню, пока сервер думал, — показ уже не к месту.
  if (left <= 0 || !alive()) {
    giveUp(offer.sessionId, fields, deps, startedAt);
    return "skipped";
  }

  const creative = offer.creative ?? null;
  const request = requestOf(offer);
  const show = deps.show;
  const outcome: AdShowOutcome =
    creative !== null
      ? await showCreativeOffer(offer, creative, fields, deps, left)
      : request === null || show === undefined
        ? { kind: "failed", reason: "unsupported" }
        : await deps.mute(() => show({ ...request, readyWithinMs: left }));
  const ms = Math.max(0, deps.now() - startedAt);

  if (outcome.kind === "failed") {
    deps.track("ad_failed", { ...fields, reason: outcome.reason, attempt: 1, ms });
    void deps.ads.report(offer.sessionId, { outcome: "failed", reason: outcome.reason });
    return "skipped";
  }
  deps.track("ad_shown", { ...fields, completed: outcome.kind === "completed", ms });
  // Награды нет — шаг без ожидания и без повторов: игрок ждёт забег, а не сервер.
  void deps.ads.report(offer.sessionId, { outcome: outcome.kind === "completed" ? "completed" : "shown" });
  return "shown";
}

/** Показ не состоялся вовремя: отказ `late` — в воронку сервера и в аналитику. */
function giveUp(sessionId: string, fields: AdTrackFields, deps: AdWatchDeps, startedAt: number): void {
  deps.track("ad_failed", { ...fields, reason: "late", attempt: 1, ms: Math.max(0, deps.now() - startedAt) });
  void deps.ads.report(sessionId, { outcome: "failed", reason: "late" });
}
