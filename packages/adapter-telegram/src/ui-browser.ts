import type {
  PlatformUi,
  SafeAreaInsets,
  ScreenMode,
  ThemeColors,
  Unsubscribe,
  ViewportState,
} from "@bh/shared-types";

/**
 * Возможности интерфейса вне мессенджера: обычный браузер и dev-сервер.
 *
 * Живёт в адаптере Telegram, а не в оболочке: оболочка не должна знать, что
 * бывает «не Telegram» (docs/27-design-system-and-app-shell.md §2). Отступы —
 * из `env(safe-area-inset-*)`, размеры — из окна, полноэкранного режима нет.
 *
 * Это не мок для тестов, а рабочий путь: стенд испытаний и отладка открываются
 * в обычном браузере, и там всё должно работать, просто без площадки.
 */
export function createBrowserUi(): PlatformUi {
  const insetsListeners = new Set<(insets: SafeAreaInsets) => void>();
  const viewportListeners = new Set<(viewport: ViewportState) => void>();
  const activeListeners = new Set<(active: boolean) => void>();

  let insets = readEnvInsets();
  let viewport = readWindowViewport();
  let active = isDocumentVisible();
  let started = false;

  const refresh = (): void => {
    const nextInsets = readEnvInsets();
    if (!sameInsets(insets, nextInsets)) {
      insets = nextInsets;
      for (const listener of insetsListeners) listener(insets);
    }

    const nextViewport = readWindowViewport();
    if (
      nextViewport.width !== viewport.width ||
      nextViewport.height !== viewport.height
    ) {
      viewport = nextViewport;
      for (const listener of viewportListeners) listener(viewport);
    }
  };

  const onVisibility = (): void => {
    const next = isDocumentVisible();
    if (next === active) return;
    active = next;
    for (const listener of activeListeners) listener(active);
  };

  return {
    ready(): Promise<void> {
      if (!started) {
        started = true;
        globalThis.addEventListener("resize", refresh);
        globalThis.addEventListener("orientationchange", refresh);
        document.addEventListener("visibilitychange", onVisibility);
      }
      return Promise.resolve();
    },

    supportsFullscreen: false,
    defaultScreenMode: "normal" as ScreenMode,
    get screenMode(): ScreenMode {
      return "normal";
    },
    setScreenMode(): Promise<ScreenMode> {
      // Честный отказ, а не молчаливое согласие: переключатель в настройках
      // читает фактический режим и остаётся выключенным.
      return Promise.resolve("normal");
    },
    onScreenModeChange(): Unsubscribe {
      return () => undefined;
    },

    get insets(): SafeAreaInsets {
      return insets;
    },
    onInsetsChange(handler): Unsubscribe {
      insetsListeners.add(handler);
      return () => insetsListeners.delete(handler);
    },

    get viewport(): ViewportState {
      return viewport;
    },
    onViewportChange(handler): Unsubscribe {
      viewportListeners.add(handler);
      return () => viewportListeners.delete(handler);
    },
    expand(): void {
      // В браузере окно и так во всю высоту — разворачивать нечего.
    },

    setBackButton(): void {
      // Кнопки «назад» у браузера нет: оболочка рисует свою в верхней панели.
    },
    setSettingsButton(): void {
      // То же: кнопка настроек живёт в верхней панели оболочки.
    },
    setVerticalSwipesEnabled(): void {
      // Свайпом браузер не сворачивается.
    },
    setClosingConfirmation(): void {
      // Подтверждение закрытия вкладки браузер не отдаёт приложению.
    },

    get isActive(): boolean {
      return active;
    },
    onActiveChange(handler): Unsubscribe {
      activeListeners.add(handler);
      return () => activeListeners.delete(handler);
    },

    applyThemeColors(colors: ThemeColors): void {
      // Шапки у браузера нет, но цвет вкладки и адресной строки на мобильном
      // задаётся мета-тегом — иначе вокруг тёмной игры белая рамка.
      setMetaThemeColor(colors.header);
    },
  };
}

const ZERO_INSETS: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * Отступы безопасной зоны браузера. `env(safe-area-inset-*)` из JS напрямую не
 * прочитать — значение считает движок стилей, поэтому оно снимается с
 * невидимого пробника. Пробник создаётся на каждый замер и тут же убирается:
 * замер происходит при повороте экрана, а не в кадре.
 */
function readEnvInsets(): SafeAreaInsets {
  if (typeof document === "undefined") return ZERO_INSETS;

  const probe = document.createElement("div");
  probe.style.cssText = [
    "position:fixed",
    "visibility:hidden",
    "pointer-events:none",
    "top:env(safe-area-inset-top)",
    "right:env(safe-area-inset-right)",
    "bottom:env(safe-area-inset-bottom)",
    "left:env(safe-area-inset-left)",
  ].join(";");
  document.body.appendChild(probe);

  const style = getComputedStyle(probe);
  const insets: SafeAreaInsets = {
    top: toPixels(style.top),
    right: toPixels(style.right),
    bottom: toPixels(style.bottom),
    left: toPixels(style.left),
  };
  probe.remove();
  return insets;
}

function readWindowViewport(): ViewportState {
  return {
    width: globalThis.innerWidth || 0,
    height: globalThis.innerHeight || 0,
    // В браузере приложение всегда на всю доступную высоту: компактного
    // режима, из которого нужно разворачиваться, там не существует.
    expanded: true,
  };
}

function isDocumentVisible(): boolean {
  return typeof document === "undefined" ? true : !document.hidden;
}

function toPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sameInsets(left: SafeAreaInsets, right: SafeAreaInsets): boolean {
  return (
    left.top === right.top &&
    left.right === right.right &&
    left.bottom === right.bottom &&
    left.left === right.left
  );
}

function setMetaThemeColor(color: string): void {
  if (typeof document === "undefined") return;

  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta === null) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = color;
}
