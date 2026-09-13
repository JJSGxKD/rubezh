import type { RunResult, UpgradeOption } from "@bh/shared-types";
import { loadRunEngine, type HudSnapshot, type RunPauseReason, type RunSession } from "@bh/core-game";
import { create } from "zustand";
import { useDiagnostics } from "./diagnostics";
import { useMeta } from "./meta";
import { reportError, track, useShell } from "./shell";

/**
 * Текущий забег: состояние для оверлеев и команды движку
 * (docs/27-design-system-and-app-shell.md §3.1).
 *
 * Сама сессия здесь не хранится: это императивный объект с подписками, ему
 * нечего делать в сторе, который сравнивают по ссылкам. Он живёт рядом в
 * модуле, а стор держит только то, что рисуется.
 */
export type RunPhase = "idle" | "loading" | "running" | "paused" | "levelUp" | "finished" | "error";

export interface RunStartOptions {
  container: HTMLElement;
  startingWeaponId: string;
  mapId: string;
  /** плотность экрана; стенд испытаний фиксирует её ради сравнимости замеров */
  pixelRatio?: number;
}

export interface RunStore {
  phase: RunPhase;
  hud: HudSnapshot | null;
  offers: UpgradeOption[];
  /** сколько уровней ещё ждёт выбора */
  queued: number;
  level: number;
  result: RunResult | null;
  isNewRecord: boolean;
  errorMessage: string | null;
  /** причина последней паузы: сворачивание приложения показывается иначе */
  pauseReason: RunPauseReason | null;
  seed: number;

  start(options: RunStartOptions): Promise<void>;
  pause(reason: RunPauseReason): void;
  resume(): void;
  surrender(): void;
  choose(optionId: string): void;
  restart(): void;
  stop(): void;
}

let session: RunSession | null = null;
let unsubscribes: (() => void)[] = [];
let startOptions: RunStartOptions | null = null;

const IDLE = {
  phase: "idle" as RunPhase,
  hud: null,
  offers: [] as UpgradeOption[],
  queued: 0,
  level: 1,
  result: null,
  isNewRecord: false,
  errorMessage: null,
  pauseReason: null as RunPauseReason | null,
};

export const useRun = create<RunStore>((set, get) => ({
  ...IDLE,
  seed: 1,

  async start(options: RunStartOptions): Promise<void> {
    if (session !== null) return;

    const seed = nextSeed();
    set({ ...IDLE, phase: "loading", seed });
    startOptions = options;

    try {
      // Движок приходит отдельным чанком: до этого момента Phaser не
      // загружался вовсе (docs/27-design-system-and-app-shell.md §3.4).
      const engine = await loadRunEngine();
      const diagnostics = useDiagnostics.getState();
      const created = engine.start({
        container: options.container,
        seed,
        mode: "endless",
        mapId: options.mapId,
        startingWeaponId: options.startingWeaponId,
        diagnostics: {
          recordRun: diagnostics.enabled && diagnostics.recordRuns,
          fpsOverlay: diagnostics.enabled && diagnostics.fpsOverlay,
        },
        ...(options.pixelRatio === undefined ? {} : { pixelRatio: options.pixelRatio }),
      });

      session = created;
      unsubscribes = subscribe(created, set, get);
      set({ phase: "running" });
      setRunUiMode(true);

      track("run_started", {
        seed,
        weapon: options.startingWeaponId,
        map: options.mapId,
        screenMode: screenModeNow(),
        orientation: orientationNow(),
      });
    } catch (error: unknown) {
      reportError("run", `движок не загрузился: ${String(error)}`);
      set({ phase: "error", errorMessage: "error.engine" });
    }
  },

  pause(reason: RunPauseReason): void {
    if (get().phase !== "running") return;
    session?.pause(reason);
  },

  resume(): void {
    if (get().phase !== "paused") return;
    session?.resume();
  },

  surrender(): void {
    session?.abandon();
  },

  choose(optionId: string): void {
    if (get().phase !== "levelUp") return;
    track("upgrade_chosen", { option: optionId, level: get().level });
    // Фазу дальше ведёт движок: он пришлёт либо следующий выбор из очереди,
    // либо `resumed`. Своя догадка здесь затирала бы первое вторым.
    session?.chooseUpgrade(optionId);
  },

  restart(): void {
    if (session === null) return;
    const seed = nextSeed();
    set({ ...IDLE, phase: "running", seed });
    session.restart(seed);
    setRunUiMode(true);

    track("run_started", {
      seed,
      weapon: startOptions?.startingWeaponId ?? "",
      map: startOptions?.mapId ?? "",
      screenMode: screenModeNow(),
      orientation: orientationNow(),
    });
  },

  stop(): void {
    for (const unsubscribe of unsubscribes) unsubscribe();
    unsubscribes = [];
    session?.destroy();
    session = null;
    startOptions = null;
    setRunUiMode(false);
    set({ ...IDLE, phase: "idle" });
  },
}));

type SetState = (partial: Partial<RunStore>) => void;
type GetState = () => RunStore;

function subscribe(created: RunSession, set: SetState, get: GetState): (() => void)[] {
  return [
    created.on("hud", (hud) => set({ hud })),

    created.on("levelUp", ({ level, options, queued }) => {
      track("upgrade_offered", { level, count: options.length, queued });
      set({ phase: "levelUp", offers: options, queued, level });
    }),

    created.on("waveReached", ({ index, elapsedSec }) => {
      track("wave_reached", { wave: index, elapsedSec: Math.round(elapsedSec) });
    }),

    created.on("paused", ({ reason, elapsedSec }) => {
      set({ phase: "paused", pauseReason: reason });
      track("run_paused", { reason, elapsedSec: Math.round(elapsedSec) });
    }),

    created.on("resumed", () => set({ phase: "running", pauseReason: null, offers: [] })),

    created.on("finished", (result) => finishRun(result, "run_finished", set)),
    created.on("abandoned", (result) => finishRun(result, "run_abandoned", set)),

    created.on("error", ({ message }) => {
      reportError("run", message);
      set({ phase: "error", errorMessage: "error.engine" });
      void get();
    }),
  ];
}

function finishRun(
  result: RunResult,
  event: "run_finished" | "run_abandoned",
  set: SetState,
): void {
  // Рекорд пишется здесь, а не в движке: хранилище устройства — забота
  // оболочки (docs/27-design-system-and-app-shell.md §7).
  const isNewRecord = useMeta.getState().submitRun(result);
  setRunUiMode(false);
  set({ phase: "finished", result, isNewRecord });

  track(event, {
    seed: result.seed,
    survivalSec: Math.round(result.survivalSec),
    level: result.level,
    wave: result.waveReached,
    enemiesKilled: result.enemiesKilled,
    weapon: result.startingWeaponId,
    map: result.mapId,
    contentHash: result.contentHash,
    isNewRecord,
  });
}

/**
 * Режим забега на стороне площадки: вертикальные свайпы выключаются, иначе
 * движение пальцем вниз по джойстику сворачивает приложение; подтверждение
 * закрытия включается, чтобы случайный жест не оборвал забег (§5.2).
 */
function setRunUiMode(inRun: boolean): void {
  const ui = useShell.getState().adapter.ui;
  ui.setVerticalSwipesEnabled(!inRun);
  ui.setClosingConfirmation(inRun);
}

/**
 * Seed нового забега. `Math.random` здесь допустим: это не симуляция, а сам
 * seed попадает в итог забега и в отчёт диагностики — забег остаётся
 * воспроизводимым (docs/17-testing-strategy.md §3.0).
 */
function nextSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff) + 1;
}

function screenModeNow(): string {
  return useShell.getState().adapter.ui.screenMode;
}

/** Ориентация на старте забега — разрез аналитики (§5.2.1). */
function orientationNow(): string {
  const viewport = useShell.getState().adapter.ui.viewport;
  return viewport.width > viewport.height ? "landscape" : "portrait";
}
