import type { KeyValueStorage } from "@bh/shared-types";
import type { RunCues } from "@bh/core-game";
import type { AudioVolumes } from "./audio-engine";
import type { HudSound, RunSoundEvent, SoundDirector, SoundScene, UiSound } from "./sound-director";

/**
 * Звук оболочки и забега — тонкая дверь в первой загрузке
 * (docs/31-audio-and-haptics.md). Сам движок, рецепты и музыка приходят
 * отдельным чанком после первого касания: до него звук всё равно нельзя
 * включить, а весит он как пол-экрана.
 *
 * Контекст создаётся синхронно в обработчике касания, до `import()`: iOS
 * разрешает звук только внутри жеста, и контекст, созданный после ожидания
 * чанка, остался бы немым.
 *
 * Пока чанк не пришёл, звуки молча пропускаются, а сцена и громкость
 * запоминаются и применяются, когда движок готов.
 */

export type { AudioVolumes, HudSound, RunSoundEvent, SoundScene, UiSound };

export const DEFAULT_VOLUMES: AudioVolumes = { master: 60, effects: 85, ui: 70, music: 55 };

let director: SoundDirector | null = null;
let loading: Promise<SoundDirector | null> | null = null;
let context: AudioContext | null = null;
let storageRef: KeyValueStorage | undefined;
let scene: SoundScene = "lobby";
let volumes: AudioVolumes = DEFAULT_VOLUMES;
let suspended = false;

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

export const audio = {
  ui(kind: UiSound): void {
    director?.ui(kind);
  },
  cues(cues: RunCues): void {
    director?.cues(cues);
  },
  runEvent(event: RunSoundEvent): void {
    director?.runEvent(event);
  },
  hud(state: HudSound): void {
    director?.setHud(state);
  },
  setScene(next: SoundScene): void {
    scene = next;
    director?.setScene(next);
  },
  setVolumes(next: AudioVolumes): void {
    volumes = next;
    director?.setVolumes(next);
  },
  /** Приложение ушло в фон: звук останавливается целиком, а не только музыка. */
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
