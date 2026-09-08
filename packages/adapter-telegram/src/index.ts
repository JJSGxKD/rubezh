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
