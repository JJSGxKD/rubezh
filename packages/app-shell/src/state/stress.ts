import {
  loadStressEngine,
  type BenchDevice,
  type BenchProgress,
  type BenchSubmission,
  type StressSession,
} from "@bh/core-game";
import { create } from "zustand";
import { describeDevice } from "./device";
import { sendDiagnosticReport, type ReportFailure } from "./diagnostic-reports";
import { useInstall } from "./install";
import { reportError, track, useShell } from "./shell";

/**
 * Стресс-тест из раздела «Играть» (docs/28-diagnostics.md §2.3): прогон на
 * нагрузке позднего забега до предела устройства, итог — на экран и команде.
 *
 * Как и у забега, сессия живёт рядом со стором, а не в нём: это
 * императивный объект с подписками.
 */
export type StressPhase = "idle" | "loading" | "running" | "finished" | "error";

/** `disabled` — отправлять некуда: приёмник выключен или стресс-тест игроку закрыт. */
export type StressSendState = "idle" | "sending" | "sent" | "failed" | "disabled";

export interface StressStore {
  phase: StressPhase;
  progress: BenchProgress | null;
  submission: BenchSubmission | null;
  sendState: StressSendState;
  sendFailure: ReportFailure | null;
  errorMessage: string | null;

  start(container: HTMLElement): Promise<void>;
  /** остановить прогон досрочно — отчёт соберётся по снятым кадрам */
  stop(): void;
  /** уход с экрана: движок уничтожается, итог забывается */
  dispose(): void;
  send(): Promise<void>;
}

let session: StressSession | null = null;
let unsubscribes: (() => void)[] = [];
/** Номер запуска — та же защита от двойного монтирования, что у забега (`state/run.ts`). */
let startToken = 0;

const IDLE = {
  phase: "idle" as StressPhase,
  progress: null,
  submission: null,
  sendState: "idle" as StressSendState,
  sendFailure: null,
  errorMessage: null,
};

export const useStress = create<StressStore>((set, get) => ({
  ...IDLE,

  async start(container: HTMLElement): Promise<void> {
    if (session !== null) return;
    const token = ++startToken;
    set({ ...IDLE, phase: "loading" });

    try {
      const engine = await loadStressEngine();
      if (token !== startToken) return;
      const created = engine.start({
        container,
        seed: nextSeed(),
        buildVersion: useShell.getState().build.version,
        device: benchDevice(),
      });
      if (token !== startToken) {
        created.destroy();
        return;
      }

      session = created;
      unsubscribes = [
        created.on("progress", (progress) => {
          if (get().phase === "loading") set({ phase: "running" });
          set({ progress });
        }),
        created.on("finished", (submission) => {
          set({ phase: "finished", submission });
          setTestUiMode(false);
          const { report, verdict } = submission;
          track("bench_finished", {
            mode: report.profile.mode,
            stopReason: report.stoppedBy,
            peakObjects: Math.round(report.totals.peakObjects),
            verdict: verdict.level,
            reportId: submission.reportId,
          });
          void get().send();
        }),
        created.on("error", ({ message }) => {
          reportError("stress", message);
          set({ phase: "error", errorMessage: "stress.error.context" });
        }),
      ];
      setTestUiMode(true);
    } catch (error: unknown) {
      if (token !== startToken) return;
      reportError("stress", error instanceof Error ? error.message : String(error));
      set({ phase: "error", errorMessage: "error.engine" });
    }
  },

  stop(): void {
    session?.stop();
  },

  dispose(): void {
    startToken++;
    for (const unsubscribe of unsubscribes) unsubscribe();
    unsubscribes = [];
    session?.destroy();
    session = null;
    setTestUiMode(false);
    set({ ...IDLE });
  },

  async send(): Promise<void> {
    const submission = get().submission;
    if (submission === null || get().sendState === "sending") return;
    set({ sendState: "sending", sendFailure: null });
    const { adapter, build } = useShell.getState();
    const failure = await sendDiagnosticReport({
      reportId: submission.reportId,
      kind: "bench",
      appVersion: build.version,
      contentHash: build.contentHash === "" ? null : build.contentHash,
      installId: useInstall.getState().installId,
      platform: build.platform,
      occurredAt: submission.report.startedAt,
      device: describeDevice(adapter.clientInfo()),
      payload: submission,
    });
    // Пока шла отправка, человек мог уйти с экрана или начать заново.
    if (get().submission !== submission) return;
    if (failure === null) set({ sendState: "sent" });
    else if (failure === "disabled" || failure === "forbidden") set({ sendState: "disabled", sendFailure: failure });
    else set({ sendState: "failed", sendFailure: failure });
  },
}));

/**
 * Сведения об устройстве в формате стенда. Строка user-agent и Telegram ID
 * не уходят: сервер узнаёт тестера по подписи запуска, а устройство — по
 * разбору из `describeDevice`, как у статистики запусков.
 */
function benchDevice(): BenchDevice {
  const { adapter } = useShell.getState();
  const client = adapter.clientInfo();
  const device = describeDevice(client);
  return {
    userAgent: "",
    platform: device.os,
    hardwareConcurrency: device.cores ?? 0,
    deviceMemoryGb: device.memoryGb,
    screenWidth: device.screenWidth,
    screenHeight: device.screenHeight,
    devicePixelRatio: globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1,
    telegramPlatform: client.platform,
    telegramVersion: client.version,
    telegramUserId: null,
    telegramLanguage: null,
    telegramIsPremium: null,
    telegramFullscreen: adapter.ui.screenMode === "fullscreen",
  };
}

/**
 * На прогоне свайп вниз не сворачивает приложение, а закрытие переспрашивает:
 * пятиминутный замер не должен теряться от случайного жеста.
 */
function setTestUiMode(inTest: boolean): void {
  const ui = useShell.getState().adapter.ui;
  ui.setVerticalSwipesEnabled(!inTest);
  ui.setClosingConfirmation(inTest);
}

/** Seed прогона: не симуляция, а параметр, который уходит в отчёт. */
function nextSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff) + 1;
}
