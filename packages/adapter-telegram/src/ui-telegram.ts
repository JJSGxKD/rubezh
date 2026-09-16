import {
  backButton,
  closingBehavior,
  init,
  isTMA,
  miniApp,
  retrieveLaunchParams,
  settingsButton,
  swipeBehavior,
  viewport,
} from "@tma.js/sdk";
import type {
  PlatformUi,
  SafeAreaInsets,
  ScreenMode,
  ThemeColors,
  Unsubscribe,
  ViewportState,
} from "@bh/shared-types";
import { createBrowserUi } from "./ui-browser";
import { sameInsets, sumInsets } from "./insets";

/**
 * Возможности интерфейса Telegram Mini App
 * (docs/27-design-system-and-app-shell.md §5.2).
 *
 * Каждый вызов SDK идёт через `ifAvailable`: у тестеров будут и старые
 * клиенты, где половины методов нет вовсе. Молча ничего не сделать хуже, чем
 * отдать оболочке честное «не поддерживается» — она нарисует неактивный
 * переключатель с пояснением, а не сломанную кнопку.
 *
 * Вне клиента Telegram возвращается браузерная реализация: стенд испытаний и
 * отладка открываются в обычном браузере.
 */
export function createTelegramUi(): PlatformUi {
  if (!isTMA()) return createBrowserUi();

  const insetsListeners = new Set<(insets: SafeAreaInsets) => void>();
  const viewportListeners = new Set<(viewport: ViewportState) => void>();
  const screenModeListeners = new Set<(mode: ScreenMode) => void>();
  const activeListeners = new Set<(active: boolean) => void>();
  const unsubscribes: Unsubscribe[] = [];

  let insets: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  let viewportState: ViewportState = { width: 0, height: 0, expanded: true };
  let screenMode: ScreenMode = "normal";
  let active = true;
  let readyPromise: Promise<void> | null = null;

  const pushInsets = (): void => {
    // Две зоны складываются: системная (вырез камеры, полоса жестов) и
    // контентная (кнопки Telegram поверх приложения в fullscreen). Сложение —
    // осознанно консервативный выбор: ничего не окажется ни под вырезом, ни
    // под кнопками. Поведение клиентов расходится, и окончательное решение
    // принимается по итогам QA на устройствах
    // (docs/27-design-system-and-app-shell.md §5.1).
    const next = sumInsets(
      read(viewport.safeAreaInsets, ZERO_TG_INSETS),
      read(viewport.contentSafeAreaInsets, ZERO_TG_INSETS),
    );
    if (sameInsets(insets, next)) return;

    insets = next;
    for (const listener of insetsListeners) listener(insets);
  };

  const pushViewport = (): void => {
    // Высота — стабильная, а не текущая: текущая меняется во время жестов и
    // анимаций, и нижняя кнопка дёргалась бы вместе с ней.
    const next: ViewportState = {
      width: read(viewport.width, 0),
      height: read(viewport.stableHeight, 0),
      // Полноэкранный режим — развёрнутый по определению. Отдельный флаг
      // `isExpanded` описывает высоту шторки и в полноэкранном режиме у части
      // клиентов остаётся ложным: игрок видел просьбу развернуть уже
      // развёрнутое окно (docs/27-design-system-and-app-shell.md §5.2).
      expanded: read(viewport.isExpanded, true) || read(viewport.isFullscreen, false),
    };
    if (
      next.width === viewportState.width &&
      next.height === viewportState.height &&
      next.expanded === viewportState.expanded
    ) {
      return;
    }

    viewportState = next;
    for (const listener of viewportListeners) listener(viewportState);
  };

  const pushScreenMode = (): void => {
    const next: ScreenMode = read(viewport.isFullscreen, false) ? "fullscreen" : "normal";
    if (next === screenMode) return;

    // Выход из fullscreen жестом или кнопкой Telegram — тоже смена режима:
    // без этого события переключатель в настройках начинает врать.
    screenMode = next;
    for (const listener of screenModeListeners) listener(screenMode);
  };

  const pushActive = (): void => {
    const next = read(miniApp.isActive, true);
    if (next === active) return;
    active = next;
    for (const listener of activeListeners) listener(active);
  };

  return {
    ready(): Promise<void> {
      readyPromise ??= mountAll().then(() => {
        unsubscribes.push(
          viewport.safeAreaInsets.sub(pushInsets),
          viewport.contentSafeAreaInsets.sub(pushInsets),
          viewport.width.sub(pushViewport),
          viewport.stableHeight.sub(pushViewport),
          viewport.isExpanded.sub(pushViewport),
          viewport.isFullscreen.sub(pushScreenMode),
          // Тот же сигнал меняет и «развёрнуто ли»: без этой подписки плашка
          // висела бы до следующего изменения размеров окна.
          viewport.isFullscreen.sub(pushViewport),
          miniApp.isActive.sub(pushActive),
        );
        pushInsets();
        pushViewport();
        pushScreenMode();
        pushActive();
      });
      return readyPromise;
    },

    get supportsFullscreen(): boolean {
      return viewport.requestFullscreen.isAvailable();
    },
    get defaultScreenMode(): ScreenMode {
      return isHandheld() ? "fullscreen" : "normal";
    },
    get screenMode(): ScreenMode {
      return screenMode;
    },
    async setScreenMode(mode: ScreenMode): Promise<ScreenMode> {
      const request = mode === "fullscreen" ? viewport.requestFullscreen : viewport.exitFullscreen;
      const call = request.ifAvailable();
      // Клиент вправе отказать — например, при недостаточной версии Bot API.
      // Возвращаем фактический режим, а не запрошенный: настройка обязана
      // совпадать с тем, что игрок видит на экране.
      if (call.ok) await call.data.catch(() => undefined);

      pushScreenMode();
      return screenMode;
    },
    onScreenModeChange(handler): Unsubscribe {
      screenModeListeners.add(handler);
      return () => screenModeListeners.delete(handler);
    },

    get insets(): SafeAreaInsets {
      return insets;
    },
    onInsetsChange(handler): Unsubscribe {
      insetsListeners.add(handler);
      return () => insetsListeners.delete(handler);
    },

    get viewport(): ViewportState {
      return viewportState;
    },
    onViewportChange(handler): Unsubscribe {
      viewportListeners.add(handler);
      return () => viewportListeners.delete(handler);
    },
    expand(): void {
      viewport.expand.ifAvailable();
    },

    setBackButton(handler): void {
      setButton(backButton, handler, backButtonOff);
    },
    setSettingsButton(handler): void {
      setButton(settingsButton, handler, settingsButtonOff);
    },

    setVerticalSwipesEnabled(enabled: boolean): void {
      const call = enabled ? swipeBehavior.enableVertical : swipeBehavior.disableVertical;
      call.ifAvailable();
    },
    setClosingConfirmation(enabled: boolean): void {
      const call = enabled
        ? closingBehavior.enableConfirmation
        : closingBehavior.disableConfirmation;
      call.ifAvailable();
    },

    get isActive(): boolean {
      return active;
    },
    onActiveChange(handler): Unsubscribe {
      activeListeners.add(handler);
      return () => activeListeners.delete(handler);
    },

    applyThemeColors(colors: ThemeColors): void {
      miniApp.setHeaderColor.ifAvailable(colors.header);
      miniApp.setBgColor.ifAvailable(colors.background);
      miniApp.setBottomBarColor.ifAvailable(colors.bottomBar);
    },
  };
}

const ZERO_TG_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

/** Отписки от нажатий кнопок площадки: у каждой кнопки живёт не больше одной. */
const backButtonOff = { current: null as Unsubscribe | null };
const settingsButtonOff = { current: null as Unsubscribe | null };

interface PlatformButton {
  show: { ifAvailable(): unknown };
  hide: { ifAvailable(): unknown };
  onClick: { ifAvailable(listener: VoidFunction): { ok: true; data: VoidFunction } | { ok: false } };
}

/**
 * Привязать обработчик к кнопке площадки. `null` — спрятать.
 *
 * Прежняя подписка снимается всегда: кнопка «назад» переезжает между экранами
 * при каждом переходе, и без снятия к ней накопился бы десяток обработчиков —
 * одно нажатие увело бы игрока на десять экранов назад.
 */
function setButton(
  button: PlatformButton,
  handler: (() => void) | null,
  slot: { current: Unsubscribe | null },
): void {
  slot.current?.();
  slot.current = null;

  if (handler === null) {
    button.hide.ifAvailable();
    return;
  }

  const subscription = button.onClick.ifAvailable(handler);
  if (subscription.ok) slot.current = subscription.data;
  button.show.ifAvailable();
}

/**
 * Смонтировать возможности площадки. Каждая — отдельно и молча: отсутствие
 * одной не должна ронять остальные, а на старом клиенте не будет половины.
 */
async function mountAll(): Promise<void> {
  init();
  miniApp.mount.ifAvailable();
  backButton.mount.ifAvailable();
  settingsButton.mount.ifAvailable();
  swipeBehavior.mount.ifAvailable();
  closingBehavior.mount.ifAvailable();

  const mounting = viewport.mount.ifAvailable();
  // Единственная асинхронная часть: размеры и отступы клиент отдаёт запросом.
  // Ошибка здесь не повод падать — оболочка переживёт нулевые отступы, а вот
  // белый экран вместо игры не переживёт никто.
  if (mounting.ok) await mounting.data.catch(() => undefined);
}

/**
 * Телефон или планшет. Умолчание режима экрана зависит от этого: на них
 * полноэкранный, в Telegram Desktop — обычный (решение Р15).
 */
function isHandheld(): boolean {
  try {
    const platform = retrieveLaunchParams().tgWebAppPlatform;
    return platform === "android" || platform === "ios";
  } catch {
    // Битые параметры запуска — не повод падать: считаем, что не телефон, и
    // оставляем обычный режим. Игрок при желании включит полноэкранный сам.
    return false;
  }
}

/** Прочитать сигнал SDK, не падая на неготовой площадке. */
function read<T>(signal: () => T, fallback: T): T {
  try {
    return signal();
  } catch {
    return fallback;
  }
}

