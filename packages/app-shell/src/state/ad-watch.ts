import type { AdFailureReason, AdShowOutcome, AdShowRequest } from "@bh/shared-types";
import type { CreativeHooks, CreativeResult, CreativeShow } from "../ads/ad-creative";
import { audio } from "../audio";
import {
  AD_COOLDOWN,
  adDeviceOf,
  createAdsApi,
  passSession,
  type AdCreativeOffer,
  type AdOffer,
  type AdPlace,
  type AdViewerHints,
  type AdsApi,
  type InterstitialMoment,
} from "./ads-api";
import type { AnalyticsEvent, AnalyticsPayload } from "./analytics";
import { usePlatform } from "./platform";
import { track, useShell } from "./shell";

/**
 * Реклама за награду от нажатия до сессии, которую забирает хозяин места
 * (docs/35-stage4-plan.md §3.7, WP12): выдача у сервера → ролик сети →
 * шаг в воронку сервера. Награду здесь не дают — колесо и удвоение забирают
 * готовую сессию сами, потому что знают, что дать.
 *
 * У VIP ролика нет (§3.6): выдача сразу отдаёт выполненную сессию.
 *
 * Объявление сети с API (Taddy, Р78) показывает не SDK, а наш рекламный
 * блок — своим чанком при первом показе: досмотр — его отсчёт, показ и клик
 * — шаги сервера, а сети о них сообщает уже сервер.
 *
 * Модуль грузится с экраном места — первой загрузке он не нужен.
 */

/**
 * Сколько сетей пробуем за одно нажатие. Сервер после отказа выдаёт уже
 * другую сеть — у выданной часовая пауза, — и вторая попытка часто
 * спасает показ. Третья заставила бы игрока ждать слишком долго.
 */
export const AD_NETWORK_ATTEMPTS = 2;

/** Паузы перед повтором шага «досмотрено», мс: потерять досмотренный ролик из-за моргнувшей сети — хуже всего. */
export const COMPLETED_REPORT_RETRIES_MS = [800, 2_000] as const;

/**
 * Чем кончилось нажатие:
 * - `watched` — сессия готова к забору у хозяина места: досмотрено (`ad`) или VIP (`pass`);
 * - `closed` — закрыл раньше конца, награды нет;
 * - `cooldown` — место отдыхает до `retryAt`, экран устарел;
 * - `no_ads` — рекламы сейчас нет ни у одной сети;
 * - `failed` — связь, сервер или SDK: можно попробовать ещё раз.
 */
export type AdWatchResult =
  | { kind: "watched"; sessionId: string; source: "ad" | "pass" }
  | { kind: "closed" }
  | { kind: "cooldown"; retryAt: string | null }
  | { kind: "no_ads" }
  | { kind: "failed" };

export type AdShow = (request: AdShowRequest) => Promise<AdShowOutcome>;
export type CreativeShower = (show: CreativeShow, hooks: CreativeHooks) => Promise<CreativeResult>;

export interface AdWatchDeps {
  ads: Pick<AdsApi, "offer" | "report">;
  /** показ площадки; нет — площадка рекламу сетей не показывает */
  show: AdShow | undefined;
  /** наш рекламный блок для объявления сети с API */
  showCreative: CreativeShower;
  /** открыть ссылку объявления; нет — блок откроет её адаптером площадки сам */
  openLink?(url: string): void;
  /** устройство, язык и премиум — подсказки выдаче */
  viewer: AdViewerHints;
  /** звук игры молчит, пока идёт ролик: у роликов свой звук */
  mute<T>(task: () => Promise<T>): Promise<T>;
  track(event: AnalyticsEvent, payload: AnalyticsPayload): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * Отказы, после которых пробуем другую сеть: у этой рекламы нет или она
 * не смогла начать. После `timeout` игрок уже ждал минуты — второй ролик
 * подряд он не заказывал; `busy` — показ уже идёт.
 */
const NEXT_NETWORK: ReadonlySet<AdFailureReason> = new Set(["no_fill", "load_failed", "sdk_error", "misconfigured", "unsupported"]);
/** Отказы, о которых игроку говорится «рекламы нет», а не «проверьте связь». */
const NO_ADS: ReadonlySet<AdFailureReason> = new Set(["no_fill", "misconfigured", "unsupported"]);

export async function watchAd(place: AdPlace, deps: AdWatchDeps = browserDeps()): Promise<AdWatchResult> {
  let lastReason: AdFailureReason = "no_fill";
  for (let attempt = 1; attempt <= AD_NETWORK_ATTEMPTS; attempt++) {
    const response = await deps.ads.offer(place, deps.viewer);
    if (!response.ok) return { kind: "failed" };
    const offer = response.data;
    if (!offer.available) {
      if (offer.reason === AD_COOLDOWN) return { kind: "cooldown", retryAt: offer.retryAt };
      // После отказа первой сети «нет рекламы» от сервера — тот же итог, что и у неё.
      return attempt === 1 || NO_ADS.has(lastReason) ? { kind: "no_ads" } : { kind: "failed" };
    }
    const pass = passSession(offer);
    if (pass !== null) return { kind: "watched", sessionId: pass, source: "pass" };

    const creative = offer.creative ?? null;
    const show = deps.show;
    if (creative === null && show === undefined) {
      // Площадка без рекламы сетей: другая сеть тоже не покажется.
      void deps.ads.report(offer.sessionId, { outcome: "failed", reason: "unsupported" });
      return { kind: "no_ads" };
    }
    const startedAt = deps.now();
    const request = requestOf(offer);
    const outcome: AdShowOutcome =
      creative !== null
        ? await showCreativeOffer(offer, creative, { place, network: offer.network }, deps)
        : request === null || show === undefined
          ? { kind: "failed", reason: "unsupported" }
          : await deps.mute(() => show(request));
    const fields = { place, network: offer.network, ms: Math.max(0, deps.now() - startedAt) };

    if (outcome.kind === "completed") {
      deps.track("ad_shown", { ...fields, completed: true });
      return (await reportCompleted(deps, offer.sessionId)) ? { kind: "watched", sessionId: offer.sessionId, source: "ad" } : { kind: "failed" };
    }
    if (outcome.kind === "closed") {
      deps.track("ad_shown", { ...fields, completed: false });
      // Шаг без ожидания: награды всё равно нет, а игрок не должен ждать сеть.
      void deps.ads.report(offer.sessionId, { outcome: "shown" });
      return { kind: "closed" };
    }
    deps.track("ad_failed", { ...fields, reason: outcome.reason, attempt });
    void deps.ads.report(offer.sessionId, { outcome: "failed", reason: outcome.reason });
    lastReason = outcome.reason;
    if (!NEXT_NETWORK.has(outcome.reason)) break;
  }
  return NO_ADS.has(lastReason) ? { kind: "no_ads" } : { kind: "failed" };
}

/** Чем помечены события показа: место и сеть, а у межстраничной — ещё и момент. */
export interface AdTrackFields {
  place: AdPlace;
  network: string;
  moment?: InterstitialMoment;
}

/**
 * Объявление нашим блоком. Показ и клик — шагами сервера по ходу: сети о
 * них сообщает сервер. За награду — всё, кроме межстраничной.
 * `readyWithinMs` — срок на подготовку, когда показа ждёт старт забега.
 */
export async function showCreativeOffer(
  offer: Extract<AdOffer, { available: true }>,
  creative: AdCreativeOffer,
  fields: AdTrackFields,
  deps: AdWatchDeps,
  readyWithinMs?: number,
): Promise<AdShowOutcome> {
  const hooks: CreativeHooks = {
    onShown: () => void deps.ads.report(offer.sessionId, { outcome: "shown" }),
    onClick: () => {
      deps.track("ad_clicked", { ...fields });
      void deps.ads.report(offer.sessionId, { outcome: "clicked" });
    },
    ...(deps.openLink === undefined ? {} : { openLink: deps.openLink }),
  };
  const show: CreativeShow = { ad: creative.ad, viewSec: creative.viewSec, rewarded: offer.format !== "interstitial", ...(readyWithinMs === undefined ? {} : { readyWithinMs }) };
  const result = await deps.mute(() => deps.showCreative(show, hooks));
  return result.kind === "failed" ? { kind: "failed", reason: result.reason } : result;
}

const AD_FORMATS: readonly AdShowRequest["format"][] = ["rewarded", "interstitial", "task"];

/**
 * Запрос показа из выдачи. Формата нет у старого сервера — места с наградой
 * у него только видео; незнакомый формат от сервера новее клиента — `null`:
 * показывать нечем.
 */
export function requestOf(offer: Extract<AdOffer, { available: true }>): AdShowRequest | null {
  const format = AD_FORMATS.find((known) => known === (offer.format ?? "rewarded"));
  return format === undefined ? null : { network: offer.network, blockId: offer.blockId, format, keys: offer.keys ?? {}, debug: offer.debug === true };
}

/**
 * Досмотр — серверу, пока он не принял: без этого шага хозяин места
 * награду не выдаст. Отказ сервера (сессия истекла) повтором не лечится.
 */
async function reportCompleted(deps: AdWatchDeps, sessionId: string): Promise<boolean> {
  for (let retry = 0; ; retry++) {
    const response = await deps.ads.report(sessionId, { outcome: "completed" });
    if (response.ok) return true;
    const delay = COMPLETED_REPORT_RETRIES_MS[retry];
    if (delay === undefined || (response.failure !== "offline" && response.failure !== "unavailable")) return false;
    await deps.sleep(delay);
  }
}

/** Награда за рекламу выдана — для `ad_reward_claimed`: досмотр без него — награда, потерянная по дороге. */
export function trackAdReward(place: AdPlace, source: "ad" | "pass"): void {
  track("ad_reward_claimed", { place, source });
}

/** Может ли площадка показать ролик сети: без этого кнопка «за рекламу» есть только у VIP. */
export function adsPlayable(): boolean {
  return useShell.getState().adapter.showAd !== undefined;
}

/**
 * Звук игры молчит, пока идёт ролик. Сворачивание приложения посреди ролика
 * возвращает звук через синхронизацию с площадкой — поэтому на время ролика
 * его снова глушим после каждого «приложение активно».
 */
async function muted<T>(task: () => Promise<T>): Promise<T> {
  audio.setActive(false);
  const stop = usePlatform.subscribe((state) => {
    if (state.isActive) audio.setActive(false);
  });
  try {
    return await task();
  } finally {
    stop();
    audio.setActive(usePlatform.getState().isActive);
  }
}

/**
 * Блок — своим чанком при первом показе креатива. Чанк не пришёл — показа не
 * было: исход `load_failed` уходит серверу и в `ad_failed`, а выдача — к
 * следующей сети. Со сроком чанк ждём не дольше него (`late`): загрузка
 * при этом идёт дальше, и следующий показ получит блок сразу.
 */
const showCreativeLazily: CreativeShower = async (show, hooks) => {
  const startedAt = Date.now();
  const chunk = import("../ads/ad-creative").then(
    ({ showCreative }) => showCreative,
    () => null,
  );
  const within = show.readyWithinMs;
  const shower = within === undefined ? await chunk : await Promise.race([chunk, new Promise<"late">((resolve) => setTimeout(() => resolve("late"), Math.max(0, within)))]);
  if (shower === "late") return { kind: "failed", reason: "late" };
  if (shower === null) return { kind: "failed", reason: "load_failed" };
  return await shower(within === undefined ? show : { ...show, readyWithinMs: within - (Date.now() - startedAt) }, hooks);
};

/** Зависимости показа в настоящем окне — общие у роликов за награду и межстраничной. */
export function browserDeps(): AdWatchDeps {
  const adapter = useShell.getState().adapter;
  const client = adapter.clientInfo();
  return {
    ads: createAdsApi(),
    show: adapter.showAd?.bind(adapter),
    showCreative: showCreativeLazily,
    viewer: { device: adDeviceOf(client.platform), language: client.language ?? null, premium: client.premium ?? null },
    mute: muted,
    track,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
