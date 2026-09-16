import { StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PlatformAdapter } from "@bh/shared-types";
import { App } from "./app/App";
import "./design-system/fonts.css";
import "./design-system/tokens.css";
import { FONT_FAMILY, PLATFORM_COLORS } from "./design-system/tokens";
import { BootScreen, type BootStage } from "./screens/gates";
import { startAudioSync } from "./state/audio-sync";
import { useDevMode } from "./state/dev-mode";
import { useDiagnostics } from "./state/diagnostics";
import { useHints } from "./state/hints";
import { useSavedRun } from "./state/run-save";
import { useInstall } from "./state/install";
import { useMeta } from "./state/meta";
import { watchPlatform } from "./state/platform";
import { usePlaytest } from "./state/playtest";
import { useSettings } from "./state/settings";
import { initShell, track, type ShellBuildInfo, type ShellCapabilities } from "./state/shell";
import { createDeferredSink, fanOut, noopAnalytics, type AnalyticsSink, type TimedSink } from "./state/analytics";
import { installErrorReporting } from "./state/error-reporting";
import { useFeedback } from "./state/feedback";
import { useGraphics } from "./state/graphics";
import { createId } from "./state/ids";
import { REPORT_QUEUE_KEY } from "./state/report-keys";

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
  /**
   * Внешний получатель событий — консоль разработчика. На сервер события
   * уходят сами, если задан `capabilities.telemetry`.
   */
  analytics?: AnalyticsSink;
}

export interface MountedShell {
  unmount(): void;
}

/**
 * Сколько запуск ждёт свои шрифты. Дольше ждать нельзя: на медленной сети
 * игрок смотрел бы на заставку ради шрифта. Не дождались — главная откроется
 * системным шрифтом, и свой подменит его, когда придёт (fonts.css, `swap`).
 */
const FONT_WAIT_MS = 800;

export async function mountAppShell(options: MountOptions): Promise<MountedShell> {
  const startedAt = performance.now();
  const telemetrySink = createDeferredSink();
  const external = options.analytics ?? noopAnalytics;

  initShell({
    adapter: options.adapter,
    capabilities: options.capabilities,
    storage: options.adapter.storage,
    analytics: options.capabilities.telemetry === undefined ? external : fanOut(external, telemetrySink.sink),
    build: options.build,
  });
  const stopErrorReporting = installErrorReporting();

  // Заставка React подменяет заставку из index.html сразу: раскладка у них
  // одна, а этапы запуска дальше видны на полосе.
  const root: Root = createRoot(options.container);
  const render = (node: ReactNode): void => root.render(<StrictMode>{node}</StrictMode>);
  const renderBoot = (stage: BootStage): void =>
    render(<BootScreen stage={stage} version={options.build.version} />);

  renderBoot("platform");
  // Площадка готовится до главной: пока она не смонтирована, отступы и
  // размеры — нули, и интерфейс успел бы моргнуть неверной раскладкой.
  // Заставке отступы не нужны — она по центру.
  await options.adapter.ui.ready();
  options.adapter.ui.applyThemeColors(PLATFORM_COLORS);

  renderBoot("fonts");
  const fontsLoaded = await waitForFonts(FONT_WAIT_MS);

  renderBoot("ready");
  const stopWatching = watchPlatform();
  useInstall.getState().hydrate();
  if (useInstall.getState().firstOpen) track("app_first_open");
  useDiagnostics.getState().hydrate(options.capabilities.diagnosticsByDefault);
  useMeta.getState().hydrate();
  useHints.getState().hydrate();
  useSavedRun.getState().hydrate();
  usePlaytest.getState().hydrate();
  useDevMode.getState().hydrate();
  useGraphics.getState().hydrate();
  useFeedback.getState().hydrate();
  useSettings.getState().hydrate(options.adapter.ui.defaultScreenMode);
  // Звук — после настроек: громкость игрока применяется с первого звука.
  const stopAudio = startAudioSync();

  render(<App />);
  // Забеги, не дошедшие до сервера в прошлый раз, уходят после главной: ради
  // них игрок не должен ждать заставку. Затем профиль: рекорд, поставленный
  // на другом устройстве, появляется на главной.
  void usePlaytest
    .getState()
    .flush("launch")
    .then(() => usePlaytest.getState().loadProfile());
  void usePlaytest.getState().loadAccess();
  void usePlaytest.getState().reportSession();
  const stopTelemetry = startTelemetry(options, telemetrySink.attach);
  // Записи забегов, не ушедшие в прошлый раз, досылаются после главной. Чанк
  // очереди грузится, только если в ней что-то лежит: у обычного игрока пусто.
  if (options.capabilities.telemetry !== undefined && (options.adapter.storage?.get(REPORT_QUEUE_KEY) ?? null) !== null) {
    import("./state/run-report")
      .then(({ startReportQueue }) => startReportQueue())
      .catch((error: unknown) => console.warn("Очередь отчётов не загрузилась:", error));
  }

  // Время до интерактивной главной — бюджет первой загрузки проверяется не
  // только размером файлов, но и на устройствах тестеров (§3.4).
  track("load_time", {
    phase: "shell_ready",
    ms: Math.round(performance.now() - startedAt),
    fontsLoaded,
  });

  return {
    unmount(): void {
      stopWatching();
      stopAudio();
      stopErrorReporting();
      stopTelemetry();
      root.unmount();
    },
  };
}

/**
 * Эмиттер событий грузится отдельным чанком после главной: игроку он в первые
 * секунды не нужен, а события до него копит буфер (`createDeferredSink`).
 * Сворачивание отправляет накопленное с keepalive, появление сети — сразу.
 */
function startTelemetry(options: MountOptions, attach: (target: TimedSink) => void): () => void {
  const config = options.capabilities.telemetry;
  if (config === undefined) return () => undefined;

  let stopped = false;
  let cleanup = (): void => undefined;
  import("./state/telemetry")
    .then(({ createTelemetry }) => {
      if (stopped) return;
      const telemetry = createTelemetry(config, {
        storage: options.adapter.storage,
        installId: () => useInstall.getState().installId,
        sessionId: createId(),
        appVersion: options.build.version,
        platform: options.build.platform,
        signedLaunchData: () => options.adapter.signedLaunchData(),
      });
      attach((event, payload, atMs) => telemetry.record(event, payload, atMs));
      const onVisibility = (): void => {
        if (document.visibilityState === "hidden") void telemetry.flush("hidden");
      };
      const onOnline = (): void => void telemetry.flush("online");
      document.addEventListener("visibilitychange", onVisibility);
      globalThis.addEventListener("online", onOnline);
      void telemetry.flush("launch");
      cleanup = () => {
        telemetry.stop();
        document.removeEventListener("visibilitychange", onVisibility);
        globalThis.removeEventListener("online", onOnline);
      };
    })
    .catch((error: unknown) => {
      // Чанк не пришёл — события остаются у внешнего получателя, игра идёт.
      console.warn("Эмиттер событий не загрузился:", error);
    });
  return () => {
    stopped = true;
    cleanup();
  };
}

/**
 * Дождаться своих гарнитур, но не дольше `timeoutMs`. `document.fonts.load`
 * сам запускает загрузку файла из fonts.css — до этого браузер скачал бы его,
 * только встретив текст этим шрифтом, то есть уже на главной.
 */
async function waitForFonts(timeoutMs: number): Promise<boolean> {
  if (typeof document === "undefined" || !("fonts" in document)) return false;

  // Образец с кириллицей и латиницей: иначе браузер загрузил бы только одно
  // подмножество из двух (fonts.css, unicode-range).
  const sample = "Рубеж Run 0";
  const loading = Promise.all([
    document.fonts.load(`700 16px "${FONT_FAMILY.display}"`, sample),
    document.fonts.load(`400 16px "${FONT_FAMILY.text}"`, sample),
  ]).then(
    () => true,
    () => false,
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });

  try {
    return await Promise.race([loading, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export type { ShellBuildInfo, ShellCapabilities } from "./state/shell";
export type { PlaytestApiConfig } from "./state/playtest-api";
export type { AnalyticsEvent, AnalyticsPayload, AnalyticsSink } from "./state/analytics";
export { COLORS, PLATFORM_COLORS } from "./design-system/tokens";
