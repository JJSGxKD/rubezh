import type {
  PlatformUi,
  SafeAreaInsets,
  ScreenMode,
  Unsubscribe,
  ViewportState,
} from "./index";

/**
 * Пустая реализация возможностей интерфейса площадки.
 *
 * Живёт рядом с контрактом, а не в каждом адаптере: заглушки MAX и VK иначе
 * повторяли бы одни и те же сто строк «ничего не делаю», и любое расширение
 * интерфейса требовало бы трёх одинаковых правок. Заодно это эталон для
 * контрактного теста адаптеров (docs/17-testing-strategy.md §5).
 *
 * Все значения честные, а не выдуманные: полноэкранного режима нет, отступы
 * нулевые, размеры нулевые до первого измерения. Оболочка от этого не
 * ломается — она обязана работать на площадке, которая ничего не умеет.
 */
export function createNoopPlatformUi(): PlatformUi {
  const insets: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  const viewport: ViewportState = { width: 0, height: 0, expanded: true };
  const unsubscribe: Unsubscribe = () => undefined;

  return {
    ready: () => Promise.resolve(),
    supportsFullscreen: false,
    defaultScreenMode: "normal",
    screenMode: "normal",
    setScreenMode: (): Promise<ScreenMode> => Promise.resolve("normal"),
    onScreenModeChange: () => unsubscribe,
    insets,
    onInsetsChange: () => unsubscribe,
    viewport,
    onViewportChange: () => unsubscribe,
    expand: () => undefined,
    setBackButton: () => undefined,
    setSettingsButton: () => undefined,
    setVerticalSwipesEnabled: () => undefined,
    setClosingConfirmation: () => undefined,
    isActive: true,
    onActiveChange: () => unsubscribe,
    applyThemeColors: () => undefined,
  };
}
