import { createNoopPlatformUi } from "@bh/shared-types";
import type {
  PlatformAdapter,
  UserContext,
  SharePayload,
  InvitePayload,
  InviteResult,
  HapticType,
  AdResult,
  DisplayUser,
  PlatformUi,
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
  /**
   * Возможности интерфейса площадки. Заглушка до портирования: адаптер честно
   * сообщает, что ничего не умеет, и оболочка рисует неактивные переключатели
   * вместо сломанных (docs/27-design-system-and-app-shell.md §5.2).
   */
  readonly ui: PlatformUi = createNoopPlatformUi();

  /** параметры запуска площадки ещё не разбираются — портирование после лонча */
  readonly displayUser: DisplayUser | null = null;

  async init(): Promise<UserContext> {
    // TODO: VKWebAppInit -> VKWebAppGetUserInfo, sign на бэкенд
    throw new Error("VkAdapter.init: не реализовано");
  }

  // Оплата — VKWebAppShowOrderBox; до портирования метода `openInvoice` нет,
  // и оболочка покупку здесь не предлагает.

  share(_payload: SharePayload): void {
    // TODO: VKWebAppShowWallPostBox / VKWebAppShare
  }

  async invite(_invite: InvitePayload): Promise<InviteResult> {
    // Площадка портируется после лонча в Telegram: приглашать пока некуда.
    return "unavailable";
  }

  signedLaunchData(): string | null {
    // Схема подписи площадки появится вместе с портированием.
    return null;
  }

  clientInfo(): { platform: string | null; version: string | null } {
    return { platform: "vk", version: null };
  }

  haptic(_type: HapticType): void {
    // TODO: VKWebAppTapticImpactOccurred
  }

  async showAd(): Promise<AdResult> {
    // TODO: нативный VK Ads SDK, rewarded video
    return { shown: false, rewarded: false };
  }
}
