import { MainScene, type MainSceneData } from "../game/MainScene";
import type { RunEngine, RunEvents, RunOptions, RunPauseReason, RunSession } from "../run-api";
import { createPhaserHost } from "./phaser-host";
import { RunBus } from "./run-bus";

/**
 * Реализация публичного контракта забега (docs/27-design-system-and-app-shell.md
 * §3.1). Живёт в отдельном чанке: этот файл — единственная дверь, за которой
 * начинается Phaser. Оболочка открывает её, когда игрок уже в лобби и
 * браузер простаивает, — к нажатию «Играть» чанк обычно на месте (§3.4).
 */
export function createRunEngine(): RunEngine {
  return {
    start(options: RunOptions): RunSession {
      const bus = new RunBus();
      const host = createPhaserHost({
        container: options.container,
        onContextLost: (message) => bus.emit("error", { message }),
        ...(options.pixelRatio === undefined ? {} : { pixelRatio: options.pixelRatio }),
        ...(options.renderCapFps === undefined ? {} : { renderCapFps: options.renderCapFps }),
      });

      const sceneData: MainSceneData = {
        seed: options.seed,
        unitScale: host.pixelRatio,
        mapId: options.mapId,
        ...(options.startingWeaponId === ""
          ? {}
          : { startingWeaponId: options.startingWeaponId }),
        ...(options.resume === undefined ? {} : { resume: options.resume }),
        bus,
      };
      host.game.scene.add("main", MainScene, true, sceneData);

      /**
       * Сцена ищется по имени на каждую команду, а не запоминается ссылкой:
       * `restart` пересоздаёт её состояние, и запомненный объект однажды
       * оказался бы прошлым забегом.
       */
      const scene = (): MainScene | null => {
        const found = host.game.scene.getScene("main");
        return found instanceof MainScene ? found : null;
      };

      return {
        on<E extends keyof RunEvents>(
          event: E,
          handler: (payload: RunEvents[E]) => void,
        ): () => void {
          return bus.on(event, handler);
        },
        chooseUpgrade(optionId: string): void {
          scene()?.applyChoice(optionId);
        },
        pause(reason: RunPauseReason): void {
          scene()?.pauseRun(reason);
        },
        resume(): void {
          scene()?.resumeRun();
        },
        abandon(): void {
          scene()?.abandonRun();
        },
        restart(seed: number): void {
          scene()?.restartRun(seed);
        },
        snapshot() {
          return scene()?.captureSnapshot() ?? null;
        },
        destroy(): void {
          bus.clear();
          host.destroy();
        },
      };
    },
  };
}
