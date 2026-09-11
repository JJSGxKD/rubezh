import { isTMA, retrieveLaunchParams } from "@tma.js/sdk";
import type {
  PlatformAdapter,
  UserContext,
  PurchaseResult,
  SharePayload,
  HapticType,
  AdResult,
} from "@bh/shared-types";

/**
 * Telegram WebApp SDK. Валидация initData (HMAC-SHA256 токеном бота) —
 * на бэкенде, не здесь. См. docs/01-tech-stack.md §4.
 * Оплата — обязательно Telegram Stars для цифровых товаров, см.
 * docs/01-tech-stack.md §5 и docs/08-web-and-identity.md §6 (важное
 * ограничение — TON/Gram/USDT НЕ заменяют Stars внутри Mini App).
 * Реклама — несколько провайдеров с fallback-цепочкой + SocialLead
 * (пассивные баннеры/промо-посты/квесты), см. docs/07-monetization-and-ads.md.
 */
export class TelegramAdapter implements PlatformAdapter {
  async init(): Promise<UserContext> {
    // TODO: window.Telegram.WebApp.initData -> отправить на бэкенд для валидации
    throw new Error("TelegramAdapter.init: не реализовано");
  }

  async purchase(_itemId: string): Promise<PurchaseResult> {
    // TODO: Telegram Stars invoice flow
    throw new Error("TelegramAdapter.purchase: не реализовано");
  }

  share(_payload: SharePayload): void {
    // TODO: Telegram.WebApp.shareMessage / switchInlineQuery
  }

  haptic(_type: HapticType): void {
    // TODO: Telegram.WebApp.HapticFeedback
  }

  async showAd(): Promise<AdResult> {
    // TODO: fallback-цепочка нескольких провайдеров, см. docs/07-monetization-and-ads.md §2
    return { shown: false, rewarded: false };
  }
}

/**
 * Сведения о клиенте Telegram: какой это WebView, какой версии и кто открыл.
 *
 * Живёт в адаптере, а не в приложении: работа с SDK площадки — это ровно та
 * граница, ради которой адаптеры и заведены (docs/01-tech-stack.md §1).
 * Нужны для отчётов FPS-испытаний (docs/25-week1-fps-trials.md): без версии
 * клиента и модели устройства цифры не с чем сопоставлять.
 */
export interface TelegramClientInfo {
  /** android / ios / tdesktop / macos / weba и прочие */
  platform: string | null;
  /** версия Bot API, поддерживаемая клиентом */
  version: string | null;
  userId: string | null;
  languageCode: string | null;
  isPremium: boolean | null;
  isFullscreen: boolean | null;
}

const UNKNOWN_CLIENT: TelegramClientInfo = {
  platform: null,
  version: null,
  userId: null,
  languageCode: null,
  isPremium: null,
  isFullscreen: null,
};

export function describeTelegramClient(): TelegramClientInfo {
  if (!isTMA()) return UNKNOWN_CLIENT;

  try {
    const launchParams = retrieveLaunchParams();
    const user = launchParams.tgWebAppData?.user;

    return {
      platform: launchParams.tgWebAppPlatform ?? null,
      version: launchParams.tgWebAppVersion ?? null,
      userId: user === undefined ? null : String(user.id),
      languageCode: user?.language_code ?? null,
      isPremium: user?.is_premium ?? null,
      isFullscreen: launchParams.tgWebAppFullscreen ?? null,
    };
  } catch (error: unknown) {
    // Параметры запуска бывают битыми или отсутствуют вовсе — например, при
    // открытии по прямой ссылке вне клиента. Это не повод падать: стенд
    // испытаний обязан работать и в обычном браузере, просто без этих полей.
    console.warn("Не удалось прочитать параметры запуска Telegram:", error);
    return UNKNOWN_CLIENT;
  }
}
