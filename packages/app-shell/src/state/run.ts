import type { DifficultyId, RunResult, UpgradeOption } from "@bh/shared-types";
import {
  loadRunEngine,
  type HudSnapshot,
  type RunPauseReason,
  type RunSession,
  type RunSnapshot,
} from "@bh/core-game";
import { create } from "zustand";
import { useDiagnostics } from "./diagnostics";
import { useMeta } from "./meta";
import { usePlaytest } from "./playtest";
import { useSavedRun } from "./run-save";
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

/**
 * Этап загрузки забега для экрана загрузки: чанк движка, затем мир до первого
 * снимка HUD. `null` — загрузки нет, в том числе при «Ещё раз»: сцена там уже
 * жива, и экран загрузки только мигнул бы.
 */
export type RunLoadingStage = "engine" | "world";

export interface RunStartOptions {
  container: HTMLElement;
  startingWeaponId: string;
  mapId: string;
  difficultyId: DifficultyId;
  /** плотность экрана; стенд испытаний фиксирует её ради сравнимости замеров */
  pixelRatio?: number;
  /** продолжить сохранённый забег вместо нового */
  resume?: RunSnapshot;
}

/**
 * Как часто забег сохраняется сам, секунды забега. Кроме этого он
 * сохраняется на паузе, на выборе улучшения и при уходе с экрана: вылет
 * между сохранениями отнимает у игрока не больше этого времени.
 */
const AUTOSAVE_SEC = 15;

export interface RunStore {
  phase: RunPhase;
  loadingStage: RunLoadingStage | null;
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
  /**
   * Забег, который откроет следующий заход на экран забега; `null` — новый.
   * Снимается с очереди, только когда сессия создана: в режиме разработки
   * React запускает экран дважды, и первый запуск не должен съесть снимок.
   */
  pendingResume: RunSnapshot | null;
  prepareResume(snapshot: RunSnapshot | null): void;
}

let session: RunSession | null = null;
let unsubscribes: (() => void)[] = [];
let startOptions: RunStartOptions | null = null;

/**
 * Номер попытки запуска. Загрузка движка асинхронная, а экран забега за это
 * время успевает размонтироваться и смонтироваться заново — в режиме
 * разработки React делает это на каждом заходе намеренно.
 *
 * Проверки «сессия ещё не создана» для этого мало: обе попытки видят `null`,
 * обе доходят до конца и создают по игре Phaser. Каждая игра — это отдельный
 * контекст WebGL; браузер держит их ограниченное число и тихо убивает самый
 * старый. Убитый контекст выглядит как замершая картинка при живом HUD:
 * игровой цикл идёт, а рисовать больше некуда. Отсюда же перезагрузки
 * страницы на ровном месте.
 *
 * Поэтому у запуска есть номер: пока идёт загрузка, любой новый запуск или
 * остановка делают предыдущий недействительным, и его игра не создаётся вовсе.
 */
let startToken = 0;

/** Когда игрок начал забег — от этой точки считается время до первого кадра. */
let firstFrameStartedAt: number | null = null;

/** Секунда забега, на которой он сохранялся последний раз. */
let lastSavedSec = 0;

const IDLE = {
  phase: "idle" as RunPhase,
  loadingStage: null as RunLoadingStage | null,
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
  pendingResume: null,

  prepareResume(snapshot): void {
    set({ pendingResume: snapshot });
  },

  async start(options: RunStartOptions): Promise<void> {
    // Уже идущий забег не перезапускаем: за этим есть отдельная команда.
    if (session !== null) return;

    const token = ++startToken;
    const resume = options.resume;
    const seed = resume?.seed ?? nextSeed();
    set({ ...IDLE, phase: "loading", loadingStage: "engine", seed });
    startOptions = options;
    firstFrameStartedAt = performance.now();
    lastSavedSec = resume?.summary.survivalSec ?? 0;
    // Новый забег занимает единственное место сохранения: старое игрок уже
    // бросил, согласившись в лобби.
    if (resume === undefined) useSavedRun.getState().clear();

    try {
      // Движок приходит отдельным чанком; обычно он уже предзагружен из лобби
      // (`preloadRunEngine`), и ожидание здесь мгновенное
      // (docs/27-design-system-and-app-shell.md §3.4).
      const engine = await loadRunEngine();
      // Пока грузился чанк, нас могли остановить или запустить заново. Игру
      // в этом случае не создаём вовсе: лишний контекст WebGL дороже всего.
      if (token !== startToken) return;
      set({ loadingStage: "world" });

      const diagnostics = useDiagnostics.getState();
      const created = engine.start({
        container: options.container,
        seed,
        mode: "endless",
        mapId: options.mapId,
        difficultyId: options.difficultyId,
        startingWeaponId: options.startingWeaponId,
        diagnostics: {
          recordRun: diagnostics.enabled && diagnostics.recordRuns,
          fpsOverlay: diagnostics.enabled && diagnostics.fpsOverlay,
        },
        ...(options.pixelRatio === undefined ? {} : { pixelRatio: options.pixelRatio }),
        ...(resume === undefined ? {} : { resume }),
      });

      if (token !== startToken) {
        // Остановили ровно в момент создания — убираем за собой сразу.
        created.destroy();
        return;
      }

      session = created;
      unsubscribes = subscribe(created, set, get);
      set({ pendingResume: null });
      // Продолженный забег движок сам ставит на паузу или на выбор — фазу
      // пришлёт событие, своя догадка здесь её затёрла бы.
      if (get().phase === "loading") set({ phase: "running" });
      setRunUiMode(true);

      if (resume !== undefined) {
        track("run_resumed", {
          seed,
          elapsedSec: Math.round(resume.summary.survivalSec),
          level: resume.summary.level,
        });
        return;
      }
      track("run_started", {
        seed,
        weapon: options.startingWeaponId,
        map: options.mapId,
        difficulty: options.difficultyId,
        screenMode: screenModeNow(),
        orientation: orientationNow(),
      });
    } catch (error: unknown) {
      reportError("run", `движок не загрузился: ${String(error)}`);
      firstFrameStartedAt = null;
      set({ phase: "error", loadingStage: null, errorMessage: "error.engine" });
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
    lastSavedSec = 0;
    session.restart(seed);
    setRunUiMode(true);

    track("run_started", {
      seed,
      weapon: startOptions?.startingWeaponId ?? "",
      map: startOptions?.mapId ?? "",
      difficulty: startOptions?.difficultyId ?? "",
      screenMode: screenModeNow(),
      orientation: orientationNow(),
    });
  },

  stop(): void {
    // Уход с экрана посреди забега — не конец забега: он сохраняется и ждёт
    // в лобби.
    if (isInProgress(get().phase)) saveRun();
    // Незавершённый запуск тоже отменяем: иначе он доедет и создаст игру,
    // которой уже некому владеть.
    startToken++;
    for (const unsubscribe of unsubscribes) unsubscribe();
    unsubscribes = [];
    session?.destroy();
    session = null;
    startOptions = null;
    firstFrameStartedAt = null;
    setRunUiMode(false);
    set({ ...IDLE, phase: "idle" });
  },
}));

type SetState = (partial: Partial<RunStore>) => void;
type GetState = () => RunStore;

function subscribe(created: RunSession, set: SetState, get: GetState): (() => void)[] {
  return [
    created.on("hud", (hud) => {
      // Первый снимок HUD — первый кадр забега: сцена создана и мир живёт.
      if (firstFrameStartedAt !== null) {
        track("load_time", {
          phase: "run_first_frame",
          ms: Math.round(performance.now() - firstFrameStartedAt),
        });
        firstFrameStartedAt = null;
      }
      set({ hud, loadingStage: null });
      if (hud.survivalSec - lastSavedSec >= AUTOSAVE_SEC && get().phase === "running") saveRun();
    }),

    created.on("levelUp", ({ level, options, queued }) => {
      track("upgrade_offered", { level, count: options.length, queued });
      set({ phase: "levelUp", offers: options, queued, level });
      saveRun();
    }),

    created.on("waveReached", ({ index, elapsedSec }) => {
      track("wave_reached", { wave: index, elapsedSec: Math.round(elapsedSec) });
    }),

    created.on("paused", ({ reason, elapsedSec }) => {
      set({ phase: "paused", pauseReason: reason });
      // Сворачивание — самый частый путь к закрытию приложения: сохраняемся
      // сразу, а не на следующем автосохранении, до которого дело не дойдёт.
      if (reason !== "restored") {
        saveRun();
        track("run_paused", { reason, elapsedSec: Math.round(elapsedSec) });
      }
    }),

    created.on("resumed", () => set({ phase: "running", pauseReason: null, offers: [] })),

    created.on("finished", (result) => finishRun(result, "run_finished", set)),
    created.on("abandoned", (result) => finishRun(result, "run_abandoned", set)),

    created.on("error", ({ message }) => {
      reportError("run", message);
      // Не прочиталось сохранение — второй раз оно тоже не прочитается, и
      // «Продолжить» в лобби вело бы в ту же ошибку.
      if (startOptions?.resume !== undefined && get().hud === null) {
        useSavedRun.getState().clear();
        set({ phase: "error", loadingStage: null, errorMessage: "error.resume" });
        return;
      }
      // Забег уже шёл — значит сломался не запуск, а отрисовка. Игроку это
      // разные вещи: в первом случае не загрузилось, во втором замерла
      // картинка, и текст должен говорить именно об этом.
      const started = get().phase !== "loading";
      set({
        phase: "error",
        loadingStage: null,
        errorMessage: started ? "error.render" : "error.engine",
      });
    }),
  ];
}

function finishRun(
  result: RunResult,
  event: "run_finished" | "run_abandoned",
  set: SetState,
): void {
  // Кончившийся забег продолжать нечего.
  useSavedRun.getState().clear();
  // Рекорд пишется здесь, а не в движке: хранилище устройства — забота
  // оболочки (docs/27-design-system-and-app-shell.md §7).
  const isNewRecord = useMeta.getState().submitRun(result);
  // Лидерборд плейтеста — поверх рекорда на устройстве, а не вместо него:
  // без сети игрок всё равно видит свой рекорд сразу.
  usePlaytest.getState().submitRun(result);
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
    difficulty: result.difficultyId,
    contentHash: result.contentHash,
    isNewRecord,
  });
}

function isInProgress(phase: RunPhase): boolean {
  return phase === "running" || phase === "paused" || phase === "levelUp";
}

/**
 * Сохранить забег на устройство. Снимок снимается синхронно и весит десятки
 * килобайт, поэтому не на каждом кадре, а по событиям и раз в `AUTOSAVE_SEC`.
 */
function saveRun(): void {
  const snapshot = session?.snapshot() ?? null;
  if (snapshot === null) return;
  lastSavedSec = snapshot.summary.survivalSec;
  useSavedRun.getState().save(snapshot);
}

let preloading = false;

/**
 * Предзагрузить чанк движка, пока игрок в лобби (docs/27-design-system-and-app-shell.md
 * §3.4): тогда «Играть» открывает забег без ожидания сети.
 *
 * Не грузим, если игрок включил экономию трафика или сети нет. Второе важнее,
 * чем кажется: браузер может запомнить неудавшийся динамический импорт, и
 * предзагрузка без сети сломала бы и сам забег до перезапуска приложения.
 */
export function preloadRunEngine(): void {
  if (preloading || session !== null) return;

  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData === true || navigator.onLine === false) return;

  preloading = true;
  loadRunEngine().catch((error: unknown) => {
    preloading = false;
    reportError("run", `предзагрузка движка не удалась: ${String(error)}`);
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
