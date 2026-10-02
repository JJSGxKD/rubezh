import type { PlatformId } from "../../platforms/ports/platform.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import type { SettingsReader } from "../settings/settings.service.js";

/**
 * Межстраничная по обычаям площадки (docs/35-stage4-plan.md WP12, часть 10,
 * Р79): где игроки к ней привыкли — показываем, где нет — бережём. Когда её
 * показывать, решает площадка — данными здесь; как часто — числа из панели
 * (раздел «Настройки» → «Реклама»). Чистые функции: их проверяют тесты, а
 * сервис лишь подставляет факты об игроке.
 *
 * Никогда — у VIP: межстраничная без награды, и пропуск её снимает
 * (`ads.service.ts`, §3.6).
 */

/**
 * Когда показывают межстраничную. `run_start` — при старте забега, «Играть»
 * или «Ещё раз», пока грузится движок: естественная пауза, а не прерванный
 * бой.
 */
export const INTERSTITIAL_MOMENTS = ["run_start"] as const;
export type InterstitialMoment = (typeof INTERSTITIAL_MOMENTS)[number];

/**
 * В какие моменты площадка показывает межстраничную. Telegram — только между
 * забегами. VK — так же; включится с портом площадки (этап 7), клиент VK
 * рекламу пока не показывает. В MAX и вебе — нет. Яндекс Игры встанут сюда
 * строкой, когда войдут в `PLATFORM_IDS`: там привычна и пауза посреди забега
 * раз в несколько минут с отсчётом — это будет второй момент.
 */
export const INTERSTITIAL_MOMENTS_OF: Readonly<Record<PlatformId, readonly InterstitialMoment[]>> = {
  telegram: ["run_start"],
  vk: ["run_start"],
  max: [],
  web: [],
};

/**
 * Флаг выката (раздел «Флаги» панели): межстраничную видит только доля
 * игроков. Оставить её или нет, решают удержание на первый и седьмой день и
 * доход на игрока этой доли против остальных. Флага нет или он выключен — не
 * видит никто.
 */
export const INTERSTITIAL_FLAG = "ads.interstitial";

/** Забег короче — проба, а не забег: в счёт ни новичка, ни «каждого N-го» он не идёт. */
export const COUNTED_RUN_SEC = 60;

/** Частота из панели (`settings/setting-catalog.ts`, О18). */
export interface InterstitialNumbers {
  /** показ — перед каждым N-м забегом */
  everyRuns: number;
  /** не чаще раза в столько минут */
  gapMin: number;
  /** новичок — пока не сыграл столько забегов… */
  newbieRuns: number;
  /** …и не прошло столько игровых суток с первого входа */
  newbieDays: number;
  afterPurchaseHours: number;
  afterRewardMin: number;
}

export function interstitialNumbers(settings: SettingsReader): InterstitialNumbers {
  return {
    everyRuns: settings.get(SETTINGS.interstitialEveryRuns),
    gapMin: settings.get(SETTINGS.interstitialGapMin),
    newbieRuns: settings.get(SETTINGS.interstitialNewbieRuns),
    newbieDays: settings.get(SETTINGS.interstitialNewbieDays),
    afterPurchaseHours: settings.get(SETTINGS.interstitialAfterPurchaseHours),
    afterRewardMin: settings.get(SETTINGS.interstitialAfterRewardMin),
  };
}

/** Что об игроке нужно политике. Счёт забегов — только забеги не короче `COUNTED_RUN_SEC`. */
export interface InterstitialFacts {
  /** сколько игровых суток прошло с первого входа: 0 — сегодня день первого входа; сутки — по Москве */
  daysSinceSignup: number;
  /** забегов всего — счёт останавливается на пороге новичка: больше политике не нужно */
  countedRuns: number;
  /** забегов, законченных после последней показанной межстраничной; счёт останавливается на N */
  runsSinceShown: number;
  /** последняя межстраничная на экране; `null` — не было ни одной */
  lastShownAt: Date | null;
  /** последняя оплата звёздами */
  lastPurchaseAt: Date | null;
  /** последний ролик за награду на экране — колесо, удвоение, второй шанс */
  lastRewardedAt: Date | null;
}

/**
 * Почему межстраничной сейчас нет — кодом для лога и разреза:
 * `newbie_days`, `newbie_runs` — новичок; `after_purchase`, `after_reward` —
 * пауза после покупки или ролика за награду; `gap` — пауза между показами;
 * `every_runs` — ещё не N-й забег.
 */
export type InterstitialRule = "newbie_days" | "newbie_runs" | "after_purchase" | "after_reward" | "gap" | "every_runs";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Можно ли показать межстраничную; `null` — можно. Правила независимы, и
 * отказ называет первое сработавшее — от того, что держит дольше.
 *
 * Две подряд не бывает: перед следующей должен закончиться хотя бы один
 * забег не короче минуты, а пауза между показами — не меньше минуты.
 */
export function interstitialRule(numbers: InterstitialNumbers, facts: InterstitialFacts, now: Date): InterstitialRule | null {
  if (facts.daysSinceSignup < numbers.newbieDays) return "newbie_days";
  if (facts.countedRuns < numbers.newbieRuns) return "newbie_runs";
  if (recent(facts.lastPurchaseAt, numbers.afterPurchaseHours * HOUR_MS, now)) return "after_purchase";
  if (recent(facts.lastRewardedAt, numbers.afterRewardMin * MINUTE_MS, now)) return "after_reward";
  if (recent(facts.lastShownAt, numbers.gapMin * MINUTE_MS, now)) return "gap";
  if (facts.runsSinceShown < numbers.everyRuns) return "every_runs";
  return null;
}

/** Было ли событие меньше `spanMs` назад; пауза в ноль — выключена. */
function recent(at: Date | null, spanMs: number, now: Date): boolean {
  return at !== null && spanMs > 0 && now.getTime() - at.getTime() < spanMs;
}
