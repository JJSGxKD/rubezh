import { hapticFeedback, isTMA, retrieveLaunchParams, retrieveRawInitData, shareURL } from "@tma.js/sdk";
import type {
  PlatformAdapter,
  PlatformClientInfo,
  UserContext,
  PurchaseResult,
  SharePayload,
  InvitePayload,
  InviteResult,
  HapticType,
  AdResult,
  DisplayUser,
  KeyValueStorage,
  PlatformUi,
} from "@bh/shared-types";
import { inviteFromBrowser } from "./invite";
import { createDeviceStorage } from "./storage";
import { createTelegramUi } from "./ui-telegram";

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
  /** локальный рекорд, настройки и installId — docs/27-design-system-and-app-shell.md §7 */
  readonly storage: KeyValueStorage = createDeviceStorage();

  /** возможности интерфейса площадки — docs/27-design-system-and-app-shell.md §5.2 */
  readonly ui: PlatformUi = createTelegramUi();

  /**
   * Имя и аватар из параметров запуска. Подпись `initData` здесь не
   * проверяется — это делает бэкенд, и до этапа 3 не делает никто. Поэтому
   * поле годится только для показа в профиле-заглушке и ни для чего больше
   * (docs/08-web-and-identity.md §4).
   */
  readonly displayUser: DisplayUser | null = readDisplayUser();

  /**
   * Контекст игрока из параметров запуска: кто открыл приложение по версии
   * площадки.
   *
   * **Это не проверенная личность.** Подпись `initData` проверяет бэкенд, и
   * настоящий аккаунт приходит оттуда — `app-shell/src/state/session.ts`.
   * Здешний `id` годится ровно для показа и разрезов аналитики; решать по
   * нему, чей это прогресс, чьи деньги и чьё место в топе, нельзя
   * (docs/08-web-and-identity.md §4).
   *
   * SDK к этому моменту уже смонтирован: его поднимает `ui.ready()`, с
   * которого начинается запуск оболочки.
   */
  async init(): Promise<UserContext> {
    if (!isTMA()) throw new Error("TelegramAdapter.init: приложение открыто вне Telegram");

    const client = describeTelegramClient();
    if (client.userId === null) {
      // Mini App без пользователя в параметрах запуска — открыто по прямой
      // ссылке мимо бота. Сервер такого игрока не узнает, и притворяться, что
      // контекст есть, нельзя.
      throw new Error("TelegramAdapter.init: в параметрах запуска нет пользователя");
    }

    return {
      id: client.userId,
      platform: "telegram",
      displayName: this.displayUser?.displayName ?? "Игрок",
      avatarUrl: this.displayUser?.avatarUrl ?? null,
      ...(client.languageCode === null ? {} : { locale: client.languageCode }),
    };
  }

  async purchase(_itemId: string): Promise<PurchaseResult> {
    // TODO: Telegram Stars invoice flow
    throw new Error("TelegramAdapter.purchase: не реализовано");
  }

  share(_payload: SharePayload): void {
    // TODO: Telegram.WebApp.shareMessage / switchInlineQuery
  }

  /**
   * Внутри Telegram — ссылка шеринга: клиент открывает выбор чата и
   * сворачивает мини-приложение. В браузере — системный лист «поделиться», а
   * без него копия ссылки: приглашение не должно молча не срабатывать.
   */
  async invite(invite: InvitePayload): Promise<InviteResult> {
    if (isTMA() && shareURL.isAvailable()) {
      shareURL(invite.url, invite.text);
      return "shared";
    }
    return inviteFromBrowser(invite);
  }

  /**
   * Сырая строка `initData` — ровно та, что подписана Telegram: разобранные и
   * собранные обратно параметры подпись уже не пройдут.
   */
  signedLaunchData(): string | null {
    if (!isTMA()) return null;
    try {
      return retrieveRawInitData() ?? null;
    } catch {
      // Клиент открыт без данных запуска (ссылка мимо бота) — сервер игрока не узнает.
      return null;
    }
  }

  clientInfo(): PlatformClientInfo {
    const client = describeTelegramClient();
    return { platform: client.platform, version: client.version };
  }

  /**
   * Тактильный отклик на нажатия и попадания
   * (docs/27-design-system-and-app-shell.md §4.5). Поддержка проверяется
   * перед вызовом: на старом клиенте метода нет, и молчание здесь — не баг.
   */
  haptic(type: HapticType): void {
    const call =
      type === "success" || type === "error" || type === "warning"
        ? hapticFeedback.notificationOccurred.ifAvailable(type)
        : type === "selection"
          ? hapticFeedback.selectionChanged.ifAvailable()
          : hapticFeedback.impactOccurred.ifAvailable(type);
    // Вне Telegram — в браузере Android при разработке — отклик даёт сам
    // браузер. Там, где его нет (iOS Safari), `vibrate` просто отсутствует.
    if (!call.ok) vibrateFallback(type);
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

/**
 * Открыто ли приложение внутри клиента Telegram. Приложение спрашивает это у
 * адаптера, а не у SDK напрямую: SDK площадки — ровно та граница, ради
 * которой адаптеры и заведены (docs/01-tech-stack.md §1).
 */
export function isTelegramEnvironment(): boolean {
  return isTMA();
}

function describeTelegramClient(): TelegramClientInfo {
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

/**
 * Имя и аватар из параметров запуска. Вне клиента Telegram их нет — и это
 * нормальный путь, а не ошибка: приложение открывают и в браузере.
 */
function readDisplayUser(): DisplayUser | null {
  if (!isTMA()) return null;

  try {
    const user = retrieveLaunchParams().tgWebAppData?.user;
    if (user === undefined) return null;

    const name = [user.first_name, user.last_name].filter((part) => part !== undefined).join(" ");
    return {
      displayName: name.trim() === "" ? (user.username ?? "") : name.trim(),
      avatarUrl: user.photo_url ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Шаблоны вибрации браузера, мс. Короче и реже, чем кажется нужным: у
 * `navigator.vibrate` нет силы удара, и длинная вибрация на каждое попадание
 * превращается в гул.
 */
const VIBRATE_PATTERNS: Record<HapticType, number | number[]> = {
  selection: 6,
  light: 10,
  soft: 12,
  medium: 18,
  rigid: 22,
  heavy: 32,
  success: [14, 50, 22],
  warning: [22, 70, 22],
  error: [40, 60, 40, 60, 60],
};

function vibrateFallback(type: HapticType): void {
  const nav = globalThis.navigator as (Navigator & { vibrate?: (pattern: number | number[]) => boolean }) | undefined;
  if (typeof nav?.vibrate !== "function") return;
  try {
    nav.vibrate(VIBRATE_PATTERNS[type]);
  } catch (error: unknown) {
    // Браузер вправе запретить вибрацию без жеста пользователя — это не ошибка игры.
    console.debug("Вибрация браузера недоступна:", error);
  }
}

export { createDeviceStorage } from "./storage";
export { createTelegramUi } from "./ui-telegram";
export { createBrowserUi } from "./ui-browser";
export { sameInsets, sumInsets } from "./insets";
