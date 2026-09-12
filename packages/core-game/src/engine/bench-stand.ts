import { BenchScene } from "../game/BenchScene";
import type { BenchSceneData } from "../game/bench/types";
import { createPhaserHost } from "./phaser-host";

/**
 * Стенд FPS-испытаний (docs/25-week1-fps-trials.md). Как и забег, живёт за
 * дверью динамического импорта — игрокам он не отдаётся вовсе.
 */
export interface BenchStand {
  destroy(): void;
}

export interface BenchStandOptions extends BenchSceneData {
  container: HTMLElement;
  renderCapFps?: number;
}

export function createBenchStand(options: BenchStandOptions): BenchStand {
  const { container, renderCapFps, ...sceneData } = options;
  const host = createPhaserHost({
    container,
    // Плотность берётся из сведений об устройстве, а не измеряется заново:
    // канва обязана быть создана ровно с тем множителем, который уедет
    // в отчёт, иначе замер не с чем сопоставлять.
    pixelRatio: sceneData.device.devicePixelRatio,
    ...(renderCapFps === undefined ? {} : { renderCapFps }),
  });

  host.game.scene.add("bench", BenchScene, true, sceneData);
  return { destroy: () => host.destroy() };
}
