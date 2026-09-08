import type {
  PlatformAdapter,
  UserContext,
  PurchaseResult,
  SharePayload,
  HapticType,
  AdResult,
} from "@bh/shared-types";

/**
 * VK Bridge (vk-bridge npm), VKWebAppInit. Валидация sign секретом
 * приложения на бэкенде. См. docs/01-tech-stack.md §4.
 * Оплата — VK Pay/VK ID, прямые рубли.
 * Реклама — единственная из трёх мини-апп платформ с нативным rewarded
 * video/interstitial/баннерами "из коробки", см. docs/01-tech-stack.md §6.
 * Владелец пакета — напарник (docs/06-team-and-workflow.md §2), фаза 2.
 */
export class VkAdapter implements PlatformAdapter {
  async init(): Promise<UserContext> {
    // TODO: VKWebAppInit -> VKWebAppGetUserInfo, sign на бэкенд
    throw new Error("VkAdapter.init: не реализовано");
  }

  async purchase(_itemId: string): Promise<PurchaseResult> {
    // TODO: VKWebAppShowOrderBox
    throw new Error("VkAdapter.purchase: не реализовано");
  }

  share(_payload: SharePayload): void {
    // TODO: VKWebAppShowWallPostBox / VKWebAppShare
  }

  haptic(_type: HapticType): void {
    // TODO: VKWebAppTapticImpactOccurred
  }

  async showAd(): Promise<AdResult> {
    // TODO: нативный VK Ads SDK, rewarded video
    return { shown: false, rewarded: false };
  }
}
