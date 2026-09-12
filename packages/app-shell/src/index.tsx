import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PlatformAdapter } from "@bh/shared-types";
import { App } from "./app/App";
import "./design-system/tokens.css";
import { PLATFORM_COLORS } from "./design-system/tokens";
import { useDiagnostics } from "./state/diagnostics";
import { useInstall } from "./state/install";
import { useMeta } from "./state/meta";
import { watchPlatform } from "./state/platform";
import { useSettings } from "./state/settings";
import { initShell, track, type ShellBuildInfo, type ShellCapabilities } from "./state/shell";
import { noopAnalytics, type AnalyticsSink } from "./state/analytics";

/**
 * Точка входа оболочки. Адаптер площадки приходит готовым объектом из
 * `apps/web-*`: оболочка не импортирует ни один `adapter-*`, иначе она
 * становится телеграм-оболочкой, и портирование на MAX — это её переписывание
 * (docs/27-design-system-and-app-shell.md §2).
 */
export interface MountOptions {
  container: HTMLElement;
  adapter: PlatformAdapter;
  build: ShellBuildInfo;
  capabilities: ShellCapabilities;
  /** приёмник событий; в WP8 сюда подключается конвейер аналитики */
  analytics?: AnalyticsSink;
}

export interface MountedShell {
  unmount(): void;
}

export async function mountAppShell(options: MountOptions): Promise<MountedShell> {
  const startedAt = performance.now();

  initShell({
    adapter: options.adapter,
    capabilities: options.capabilities,
    storage: options.adapter.storage,
    analytics: options.analytics ?? noopAnalytics,
    build: options.build,
  });

  // Площадка готовится до первого кадра: пока она не смонтирована, отступы и
  // размеры — нули, и интерфейс успел бы моргнуть неверной раскладкой.
  await options.adapter.ui.ready();
  options.adapter.ui.applyThemeColors(PLATFORM_COLORS);

  const stopWatching = watchPlatform();
  useInstall.getState().hydrate();
  useDiagnostics.getState().hydrate();
  useMeta.getState().hydrate();
  useSettings.getState().hydrate(options.adapter.ui.defaultScreenMode);

  const root: Root = createRoot(options.container);
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  // Время до интерактивной главной — бюджет первой загрузки проверяется не
  // только размером файлов, но и на устройствах тестеров (§3.4).
  track("load_time", { phase: "shell_ready", ms: Math.round(performance.now() - startedAt) });

  return {
    unmount(): void {
      stopWatching();
      root.unmount();
    },
  };
}

export type { ShellBuildInfo, ShellCapabilities } from "./state/shell";
export type { AnalyticsEvent, AnalyticsPayload, AnalyticsSink } from "./state/analytics";
export { COLORS, PLATFORM_COLORS } from "./design-system/tokens";
