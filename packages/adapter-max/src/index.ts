import { createNoopPlatformUi } from "@bh/shared-types";
import type {
  PlatformAdapter,
  UserContext,
  PurchaseResult,
  SharePayload,
  InvitePayload,
  InviteResult,
  HapticType,
  AdResult,
  DisplayUser,
  PlatformUi,
} from "@bh/shared-types";

/**
 * MAX Bridge / Web Apps SDK. Схема валидации initData уточняется по
 * актуальной документации dev.max.ru перед началом недели 3 — см.
 * docs/03-notes-and-risks.md (открытый вопрос).
 * Оплата — СБП/VK Pay через нативный платёжный API MAX, прямые рубли.
 * Реклама — нет нативного rewarded-SDK; showAd() значим только при
 * активном антирекламном пакете (мгновенная выдача без ролика) — см.
 * docs/07-monetization-and-ads.md §3. Пассивный доход с баннеров/промо-постов
 * через SocialLead — отдельно, не через этот метод.
 */
export class MaxAdapter implements PlatformAdapter {
  /**
   * Возможности интерфейса площадки. Заглушка до портирования: адаптер честно
   * сообщает, что ничего не умеет, и оболочка рисует неактивные переключатели
   * вместо сломанных (docs/27-design-system-and-app-shell.md §5.2).
   */
  readonly ui: PlatformUi = createNoopPlatformUi();

  /** параметры запуска площадки ещё не разбираются — портирование после лонча */
  readonly displayUser: DisplayUser | null = null;

  async init(): Promise<UserContext> {
    // TODO: MAX Bridge init-данные -> валидация на бэкенде
    throw new Error("MaxAdapter.init: не реализовано");
  }

  async purchase(_itemId: string): Promise<PurchaseResult> {
    // TODO: СБП/VK Pay через MAX payment API
    throw new Error("MaxAdapter.purchase: не реализовано");
  }

  share(_payload: SharePayload): void {
    // TODO: нативный шеринг MAX
  }

  async invite(_invite: InvitePayload): Promise<InviteResult> {
    // Площадка портируется после лонча в Telegram: приглашать пока некуда.
    return "unavailable";
  }

  haptic(_type: HapticType): void {
    // TODO: MAX Bridge haptics, если доступно
  }

  async showAd(): Promise<AdResult> {
    // Кнопка видна ТОЛЬКО если куплен антирекламный пакет — см.
    // docs/07-monetization-and-ads.md §3 за полным обоснованием.
    // Без пакета кнопка вообще не рендерится в UI, сюда не доходит.
    return { shown: true, rewarded: true };
  }
}
