import type { KeyValueStorage } from "@bh/shared-types";
import type { BossSnapshot, RunCues } from "@bh/core-game";
import type { AudioVolumes } from "./audio-engine";
import type { MusicPlayer, MusicState } from "./music";
import type { HudSound, RunSoundEvent, SoundDirector, SoundScene, UiSound } from "./sound-director";

/**
 * Звук оболочки и забега — тонкая дверь в первой загрузке
 * (docs/31-audio-and-haptics.md). Сам движок и рецепты приходят
 * отдельным чанком после первого касания: до него звук всё равно нельзя
 * включить, а весит он как пол-экрана.
 *
 * Контекст создаётся синхронно в обработчике касания, до `import()`: iOS
 * разрешает звук только внутри жеста, и контекст, созданный после ожидания
 * чанка, остался бы немым.
 *
 * Пока чанк не пришёл, звуки молча пропускаются, а сцена и громкость
 * запоминаются и применяются, когда движок готов.
 *
 * Музыка (`music.ts`) — ещё один чанк, который просят, когда движок готов:
 * треки качаются по одному и только пока регулятор не на нуле. Сцену, громкость
 * и «босс на поле» дверь хранит сама, как и для остального звука.
 */

export type { AudioVolumes, HudSound, RunSoundEvent, SoundScene, UiSound };

/**
 * Умолчания громкости. Интерфейс громче эффектов: щелчок подтверждает
 * нажатие, и в бою он тонул (docs/31-audio-and-haptics.md §6).
 */
export const DEFAULT_VOLUMES: AudioVolumes = { master: 60, effects: 85, ui: 90, music: 40 };

/**
 * Сменил ли босс фазу между снимками HUD. Выход босса звучит по сигналам
 * забега (`bossSpawns`), здесь — только рост фазы того же босса: новый босс
 * с ненулевой фазой — это выход, а не перелом боя. Живёт здесь, а не в
 * режиссёре: оболочка зовёт её на каждый снимок HUD, а режиссёр — в
 * отдельном чанке.
 */
export function bossPhaseRaised(previous: BossSnapshot | null, next: BossSnapshot | null): boolean {
  return previous !== null && next !== null && previous.enemyId === next.enemyId && next.phase > previous.phase;
}

let director: SoundDirector | null = null;
let loading: Promise<SoundDirector | null> | null = null;
let context: AudioContext | null = null;
let storageRef: KeyValueStorage | undefined;
let scene: SoundScene = "lobby";
let volumes: AudioVolumes = DEFAULT_VOLUMES;
let suspended = false;
let music: MusicPlayer | null = null;
let bossOnField = false;

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function contextCtor(): AudioContextCtor | null {
  const scope = globalThis as typeof globalThis & { webkitAudioContext?: AudioContextCtor };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/**
 * Разблокировать звук по первому касанию. Возвращает отписку — для тестов и
 * размонтирования оболочки.
 */
export function installAudioUnlock(storage: KeyValueStorage | undefined): () => void {
  storageRef = storage;
  const unlock = (): void => {
    void unlockAudio();
  };
  const options = { capture: true, passive: true } as const;
  document.addEventListener("pointerdown", unlock, options);
  document.addEventListener("keydown", unlock, options);
  return () => {
    document.removeEventListener("pointerdown", unlock, options);
    document.removeEventListener("keydown", unlock, options);
  };
}

/** Создать и возобновить контекст — синхронная часть должна идти внутри жеста. */
export function unlockAudio(): Promise<SoundDirector | null> {
  const Ctor = contextCtor();
  if (Ctor === null) return Promise.resolve(null);
  if (context === null) context = new Ctor({ latencyHint: "interactive" });
  if (context.state !== "running" && !suspended) {
    context.resume().catch((error: unknown) => console.debug("Звук ждёт следующего касания:", error));
  }
  if (loading !== null) return loading;

  const ctx = context;
  loading = Promise.all([import("./sound-director"), import("./lab-overrides")])
    .then(([{ SoundDirector: Director }, { readLabOverrides }]) => {
      const created = new Director(ctx, readLabOverrides(storageRef));
      created.setVolumes(volumes);
      created.setScene(scene);
      director = created;
      void created.prepare().catch((error: unknown) => console.warn("Звуки не отрисовались:", error));
      void startMusic(ctx, created);
      return created;
    })
    .catch((error: unknown) => {
      // Без звука игра остаётся игрой: следующее касание попробует снова.
      console.warn("Звук не загрузился:", error);
      loading = null;
      return null;
    });
  return loading;
}

/** Музыка — после движка и без ожидания: её сбой звук и игру не трогает. */
async function startMusic(ctx: AudioContext, created: SoundDirector): Promise<void> {
  try {
    const { MusicPlayer: Player } = await import("./music");
    const player = new Player(ctx, created.engine.musicInput);
    player.setVolume(volumes.music);
    player.setScene(scene);
    player.setBoss(bossOnField);
    music = player;
  } catch (error: unknown) {
    console.warn("Музыка не запустилась:", error);
  }
}

export const audio = {
  ui(kind: UiSound, rate?: number): void {
    director?.ui(kind, rate);
  },
  cues(cues: RunCues): void {
    director?.cues(cues);
  },
  runEvent(event: RunSoundEvent): void {
    director?.runEvent(event);
  },
  /** Звон `index`-й награды сундука — сцена открытия зовёт его по расписанию. */
  chestReveal(index: number): void {
    director?.chestReveal(index);
  },
  /** `boss` — босс на поле: поверх пульса забега входит его слой. */
  hud(state: HudSound, boss = false): void {
    director?.setHud(state);
    bossOnField = boss;
    music?.setBoss(boss);
  },
  setScene(next: SoundScene): void {
    scene = next;
    // Босс прошлого забега не должен вернуться слоем в следующий до первого снимка HUD.
    if (next === "lobby" || next === "finished") bossOnField = false;
    director?.setScene(next);
    music?.setBoss(bossOnField);
    music?.setScene(next);
  },
  setVolumes(next: AudioVolumes): void {
    volumes = next;
    director?.setVolumes(next);
    music?.setVolume(next.music);
  },
  /** Для лаборатории: какие треки звучат; `null` — музыка ещё не поднялась. */
  musicState(): MusicState | null {
    return music?.state() ?? null;
  },
  /** Приложение ушло в фон: контекст звука приостанавливается целиком. */
  setActive(active: boolean): void {
    suspended = !active;
    if (context === null) return;
    const action = active ? context.resume() : context.suspend();
    action.catch((error: unknown) => console.debug("Смена состояния звука не удалась:", error));
  },
  /** Для лаборатории: дождаться движка, разблокировав его, если нужно. */
  director(): Promise<SoundDirector | null> {
    return director === null ? unlockAudio() : Promise.resolve(director);
  },
};
