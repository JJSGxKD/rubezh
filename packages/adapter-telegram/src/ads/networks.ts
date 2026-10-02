import type { AdFailureReason, AdShowOutcome, AdShowRequest } from "@bh/shared-types";
import type { ScriptLoader } from "./script-loader";

/**
 * SDK рекламных сетей — тонко, по рабочей интеграции `vpnsibcom_web`
 * (`src/app/_components/ads/*`) и профилям сетей на сервере
 * (`backend/api/src/modules/ads/ad-networks.ts`). Адаптер знает, как сеть
 * показывает и чем сообщает исход, — не места и не награды.
 *
 * Перенос — адаптация (docs/13-reuse-from-vpnsibcom.md §1): в источнике
 * каждая сеть — React-компонент, рисующий «ничего» ради эффекта, скрипты
 * всех сетей грузились при запуске, а отказ и закрытие у RichAds не
 * различались. Здесь — функции без интерфейса, скрипт при первом показе,
 * контроллер блока — однажды, исход — одним из трёх.
 *
 * Taddy здесь не показывает (Р78): её креатив сервер берёт по API, а рисует
 * наш блок в оболочке. SDK Taddy поднимается только для учёта аудитории —
 * `ads/audience.ts`.
 */

export interface AdsgramResult {
  done: boolean;
  description: string;
  state: string;
  error: boolean;
}

export interface AdsgramController {
  show(): Promise<AdsgramResult>;
  addEventListener(event: string, handler: () => void): void;
  removeEventListener(event: string, handler: () => void): void;
  destroy(): void;
}

export interface SonarShowParams {
  adUnit: string;
  /** полноэкранный загрузчик SDK — у видео за награду, пока ролик грузится */
  loader?: boolean;
  onReward?: () => void;
  onClose?: () => void;
  onError?: (message?: string) => void;
}

export interface RichAdsController {
  initialize(params: { pubId: string; appId: string; debug: boolean }): void;
  triggerInterstitialVideo(): Promise<unknown>;
  triggerInterstitialBanner(): Promise<unknown>;
}

/**
 * SDK Taddy — только учёт аудитории (Р78): рекламу Taddy рисует наш блок по
 * креативу с сервера. Поля — по типам `taddy-sdk-web` 1.3.17; все
 * необязательны, потому что скрипт приходит с чужого сервера и его версия не
 * наша.
 */
export interface TaddySdk {
  isInit?: boolean;
  isReady?: boolean;
  init?(pubId: string): Promise<void>;
  /** игрок открыл приложение — SDK шлёт Taddy `events/start` */
  ready?(): Promise<void>;
}

/** Что SDK сетей кладут в `window` — в тестах подменяется целиком. */
export interface AdGlobals {
  Adsgram?: { init(params: { blockId: string; debug?: boolean }): AdsgramController };
  Sonar?: { show(params: SonarShowParams): Promise<{ status: string; message?: string } | undefined> };
  TelegramAdsController?: new () => RichAdsController;
  Taddy?: TaddySdk;
}

export interface NetworkEnv {
  globals: () => AdGlobals;
  loader: ScriptLoader;
  /** тестовые показы сетей: в проде `false` — иначе показы не засчитываются и выплат нет */
  debug: boolean;
  now: () => number;
}

export type NetworkShow = (request: AdShowRequest, env: NetworkEnv) => Promise<AdShowOutcome>;

export const ADSGRAM_SCRIPT = "https://sad.adsgram.ai/js/sad.min.js";
export const ADSONAR_SCRIPT = "https://static.sonartech.io/lib/1.0.0/sonar.js";
export const RICHADS_SCRIPT = "https://richinfo.co/richpartners/telegram/js/tg-ob.js";
export const TADDY_SCRIPT = "https://sdk.taddy.pro/web/taddy.min.js";

/**
 * Отказ RichAds быстрее этого — показа не было (нет рекламы), а не «игрок
 * закрыл»: SDK отвечает отказом в обоих случаях, а различать их нужно —
 * после «нет рекламы» сервер предложит следующую сеть, после закрытия
 * повторять показ нельзя.
 */
export const RICHADS_NO_FILL_MS = 2_000;

const failed = (reason: AdFailureReason): AdShowOutcome => ({ kind: "failed", reason });
const COMPLETED: AdShowOutcome = { kind: "completed" };
const CLOSED: AdShowOutcome = { kind: "closed" };

/** Скрипт сети — если его объекта ещё нет; не загрузился — `false`. */
export async function ensureScript(env: NetworkEnv, present: () => boolean, src: string, attributes?: Readonly<Record<string, string>>): Promise<boolean> {
  if (present()) return true;
  try {
    await env.loader.load(src, attributes);
  } catch {
    return false;
  }
  return present();
}

/** Исход — один раз: SDK, бывает, сообщает и «закрыто», и «досмотрено». Первое слово — последнее. */
function settleOnce(): { promise: Promise<AdShowOutcome>; settle: (outcome: AdShowOutcome) => void } {
  let settle: (outcome: AdShowOutcome) => void = () => undefined;
  const promise = new Promise<AdShowOutcome>((resolve) => {
    let done = false;
    settle = (outcome) => {
      if (done) return;
      done = true;
      resolve(outcome);
    };
  });
  return { promise, settle };
}

/**
 * AdsGram: `init` — однажды на блок, дальше только `show` (docs/33 §6).
 * `show` разрешается досмотром, отклоняется пропуском или ошибкой; «нет
 * рекламы» SDK сообщает отдельным событием `onBannerNotFound` — это низкий
 * филл, а не поломка, и сервер предложит другую сеть.
 */
export function createAdsgram(): NetworkShow {
  const controllers = new Map<string, AdsgramController>();
  return async (request, env) => {
    if (request.format === "task") return failed("unsupported");
    if (request.blockId === null) return failed("misconfigured");
    if (!(await ensureScript(env, () => env.globals().Adsgram !== undefined, ADSGRAM_SCRIPT))) return failed("load_failed");
    const sdk = env.globals().Adsgram;
    if (sdk === undefined) return failed("load_failed");

    let controller = controllers.get(request.blockId);
    if (controller === undefined) {
      controller = sdk.init({ blockId: request.blockId, debug: env.debug });
      controllers.set(request.blockId, controller);
    }
    let noFill = false;
    const onNotFound = () => {
      noFill = true;
    };
    controller.addEventListener("onBannerNotFound", onNotFound);
    try {
      const result = await controller.show();
      return result.done ? COMPLETED : CLOSED;
    } catch (rejection: unknown) {
      if (noFill) return failed("no_fill");
      // Пропуск ролика SDK отклоняет без признака ошибки — это закрытие, не поломка.
      const skipped = typeof rejection === "object" && rejection !== null && "error" in rejection && rejection.error === false;
      return skipped ? CLOSED : failed("sdk_error");
    } finally {
      controller.removeEventListener("onBannerNotFound", onNotFound);
    }
  };
}

/**
 * AdSonar: метод показа у всех форматов один — `Sonar.show`, формат задаёт
 * сам блок в кабинете. У видео за награду исход приходит событиями, у
 * межстраничной — завершением показа: закрыть её и есть досмотреть.
 */
export function createAdsonar(): NetworkShow {
  return async (request, env) => {
    if (request.format === "task") return failed("unsupported");
    const appId = request.keys["appId"] ?? "";
    if (request.blockId === null || appId === "") return failed("misconfigured");
    const src = `${ADSONAR_SCRIPT}?appId=${encodeURIComponent(appId)}${env.debug ? "&isDebug=true" : ""}`;
    if (!(await ensureScript(env, () => env.globals().Sonar !== undefined, src))) return failed("load_failed");
    const sdk = env.globals().Sonar;
    if (sdk === undefined) return failed("load_failed");

    if (request.format === "interstitial") {
      try {
        const result = await sdk.show({ adUnit: request.blockId, loader: false });
        return result?.status === "error" ? failed("no_fill") : COMPLETED;
      } catch {
        return failed("sdk_error");
      }
    }

    const { promise, settle } = settleOnce();
    try {
      const result = await sdk.show({
        adUnit: request.blockId,
        loader: true,
        onReward: () => settle(COMPLETED),
        onClose: () => settle(CLOSED),
        onError: () => settle(failed("sdk_error")),
      });
      // Отказ показать — статусом, без событий: ни награды, ни закрытия уже не будет.
      if (result?.status === "error") settle(failed("no_fill"));
    } catch {
      settle(failed("sdk_error"));
    }
    return await promise;
  };
}

/**
 * RichAds: контроллер — один на приложение, `initialize` — однажды с
 * `pubId` и `appId`. Видео за награду — `triggerInterstitialVideo`,
 * межстраничная — `triggerInterstitialBanner`; разрешение — показ
 * досмотрен, отказ — и «нет рекламы», и «закрыл»: их различает время
 * (`RICHADS_NO_FILL_MS`).
 */
export function createRichads(): NetworkShow {
  let controller: { key: string; instance: RichAdsController } | null = null;
  return async (request, env) => {
    if (request.format === "task") return failed("unsupported");
    const pubId = request.keys["pubId"] ?? "";
    const appId = request.keys["appId"] ?? "";
    if (pubId === "" || appId === "") return failed("misconfigured");
    if (!(await ensureScript(env, () => env.globals().TelegramAdsController !== undefined, RICHADS_SCRIPT))) return failed("load_failed");
    const Controller = env.globals().TelegramAdsController;
    if (Controller === undefined) return failed("load_failed");

    const key = `${pubId}:${appId}`;
    if (controller === null || controller.key !== key) {
      const instance = new Controller();
      instance.initialize({ pubId, appId, debug: env.debug });
      controller = { key, instance };
    }
    const startedAt = env.now();
    try {
      await (request.format === "rewarded" ? controller.instance.triggerInterstitialVideo() : controller.instance.triggerInterstitialBanner());
      return COMPLETED;
    } catch {
      return env.now() - startedAt < RICHADS_NO_FILL_MS ? failed("no_fill") : CLOSED;
    }
  };
}
