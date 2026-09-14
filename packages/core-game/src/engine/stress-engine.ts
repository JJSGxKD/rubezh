import { BenchScene } from "../game/BenchScene";
import {
  BENCH_DEFAULT_DURATION_SEC,
  BENCH_DEFAULT_RAMP_CAP,
  BENCH_POPULATIONS,
} from "../game/bench/profiles";
import type { BenchSceneData } from "../game/bench/types";
import type { StressEngine, StressEvents, StressOptions, StressSession } from "../stress-api";
import { createPhaserHost } from "./phaser-host";

type Handler<E extends keyof StressEvents> = (payload: StressEvents[E]) => void;

/**
 * Стресс-тест для оболочки: сцена стенда без своего интерфейса. Живёт за той
 * же дверью динамического импорта, что и забег, — Phaser в первую загрузку не
 * попадает.
 */
export function createStressEngine(): StressEngine {
  return {
    start(options: StressOptions): StressSession {
      const handlers: { [E in keyof StressEvents]: Set<Handler<E>> } = {
        progress: new Set(),
        finished: new Set(),
        error: new Set(),
      };
      const emit = <E extends keyof StressEvents>(event: E, payload: StressEvents[E]): void => {
        const set: Set<Handler<E>> = handlers[event];
        for (const handler of set) {
          try {
            handler(payload);
          } catch (error: unknown) {
            // Упавший обработчик оболочки не должен ронять прогон на середине.
            console.warn(`Обработчик события стресс-теста ${event} упал:`, error);
          }
        }
      };

      const host = createPhaserHost({
        container: options.container,
        // Плотность — та, что уйдёт в отчёт: иначе замер не с чем сопоставить.
        pixelRatio: options.device.devicePixelRatio,
        onContextLost: (message) => emit("error", { message }),
      });

      const sceneData: BenchSceneData = {
        mode: options.mode,
        population: options.mode === "fixed" ? BENCH_POPULATIONS[0] : BENCH_DEFAULT_RAMP_CAP,
        addPerSecond: 2,
        seed: options.seed,
        durationSec: BENCH_DEFAULT_DURATION_SEC,
        buildVersion: options.buildVersion,
        device: options.device,
        ingest: null,
        loadout: "full",
        presentation: "shell",
        listener: {
          progress: (progress) => emit("progress", progress),
          finished: (submission) => emit("finished", submission),
        },
      };
      host.game.scene.add("bench", BenchScene, true, sceneData);

      const scene = (): BenchScene | null => {
        const found = host.game.scene.getScene("bench");
        return found instanceof BenchScene ? found : null;
      };

      return {
        on<E extends keyof StressEvents>(event: E, handler: Handler<E>): () => void {
          const set: Set<Handler<E>> = handlers[event];
          set.add(handler);
          return () => {
            set.delete(handler);
          };
        },
        stop(): void {
          scene()?.stopRun();
        },
        destroy(): void {
          for (const key of Object.keys(handlers) as (keyof StressEvents)[]) handlers[key].clear();
          host.destroy();
        },
      };
    },
  };
}
