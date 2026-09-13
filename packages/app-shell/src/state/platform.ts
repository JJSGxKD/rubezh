import type { SafeAreaInsets, ScreenMode, ViewportState } from "@bh/shared-types";
import { create } from "zustand";
import { useSettings } from "./settings";
import { useShell } from "./shell";

/**
 * Зеркало состояния площадки: отступы безопасной зоны, размеры вьюпорта,
 * режим экрана и активность приложения.
 *
 * Компоненты читают отсюда, а не из адаптера напрямую: адаптер — императивный
 * объект с подписками, а React нужен снимок, на который можно подписаться
 * один раз.
 */
export interface PlatformStore {
  insets: SafeAreaInsets;
  viewport: ViewportState;
  screenMode: ScreenMode;
  isActive: boolean;
}

export const usePlatform = create<PlatformStore>(() => ({
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
  viewport: { width: 0, height: 0, expanded: true },
  screenMode: "normal",
  isActive: true,
}));

/**
 * Подписаться на площадку и держать зеркало в актуальном состоянии.
 * Возвращает отписку: оболочку монтируют и размонтируют, в том числе в тестах.
 */
export function watchPlatform(): () => void {
  const ui = useShell.getState().adapter.ui;

  const applyInsets = (insets: SafeAreaInsets): void => {
    usePlatform.setState({ insets });
    writeInsetVars(insets);
  };
  const applyViewport = (viewport: ViewportState): void => {
    usePlatform.setState({ viewport });
    writeViewportVar(viewport);
  };

  applyInsets(ui.insets);
  applyViewport(ui.viewport);
  usePlatform.setState({ screenMode: ui.screenMode, isActive: ui.isActive });

  const unsubscribes = [
    ui.onInsetsChange(applyInsets),
    ui.onViewportChange(applyViewport),
    ui.onScreenModeChange((screenMode) => {
      usePlatform.setState({ screenMode });
      // Выход из fullscreen жестом или кнопкой Telegram — тоже смена режима:
      // без синхронизации переключатель в настройках начинает врать (§5.2.1).
      useSettings.getState().syncScreenMode(screenMode);
    }),
    ui.onActiveChange((isActive) => usePlatform.setState({ isActive })),
  ];

  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

/**
 * Отступы уезжают в CSS-переменные, а не в inline-стили компонентов: вёрстка
 * обращается к `--app-inset-*` откуда угодно, в том числе из псевдоэлементов
 * (docs/27-design-system-and-app-shell.md §5.1).
 */
function writeInsetVars(insets: SafeAreaInsets): void {
  const root = document.documentElement;
  root.style.setProperty("--app-inset-top", `${insets.top}px`);
  root.style.setProperty("--app-inset-right", `${insets.right}px`);
  root.style.setProperty("--app-inset-bottom", `${insets.bottom}px`);
  root.style.setProperty("--app-inset-left", `${insets.left}px`);
}

/**
 * Высота — от площадки, а не `100vh`: во WebView iOS `100vh` включает зону под
 * панелями, и нижняя кнопка уезжает за край. Нулевую высоту игнорируем —
 * площадка отдаёт её до первого измерения.
 */
function writeViewportVar(viewport: ViewportState): void {
  if (viewport.height <= 0) return;
  document.documentElement.style.setProperty("--app-viewport-height", `${viewport.height}px`);
}
