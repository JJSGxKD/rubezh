import { DEFAULT_DIFFICULTY_ID, DEFAULT_MAP_ID } from "@bh/core-game";
import { DEFAULT_DEV_SETTINGS, devModeAllowed, useDevMode } from "../state/dev-mode";
import { useRun } from "../state/run";
import { fxScene, type FxScene } from "./fx-scenes";

/**
 * Стенд эффектов (docs/17-testing-strategy.md, «Стенд эффектов»): забег
 * разработчика без экрана выбора, поставленный на паузу с нужной сценой.
 * Скрипт шагает симуляцию через `window.__fxStand` и снимает кадр после
 * каждого шага. Подключается только на dev-сервере (index.tsx).
 */
export interface FxStand {
  /** сцена загружена, оружие выдано, забег на паузе на нулевом тике сцены */
  ready: Promise<void>;
  scene: FxScene;
  /** шаг симуляции на паузе и ожидание отрисовки кадра */
  step(ticks: number): Promise<void>;
}

declare global {
  interface Window {
    __fxStand?: FxStand;
  }
}

const READY_TIMEOUT_MS = 20_000;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function twoFrames(): Promise<void> {
  await nextFrame();
  await nextFrame();
}

/** Ждёт условия, проверяя его каждый кадр; не дождавшись — бросает с причиной. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + READY_TIMEOUT_MS;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`стенд эффектов: не дождались — ${what}`);
    await nextFrame();
  }
}

export function startFxStand(sceneId: string, ground: "map" | "light"): void {
  const scene = fxScene(sceneId);
  if (scene === null) {
    console.warn(`неизвестная сцена эффекта: ${sceneId}`);
    return;
  }
  if (!devModeAllowed()) {
    console.warn("стенд эффектов: нужно право tools.dev");
    return;
  }

  // Настройки подменяются только в памяти: `update` писал бы их в bh.dev.v1, а
  // сохранённые настройки разработчика стенд менять не должен.
  const base = DEFAULT_DEV_SETTINGS;
  useDevMode.setState({
    armed: true,
    settings: {
      ...base,
      visuals: { ...base.visuals, lightGround: ground === "light" },
      cheats: { ...base.cheats, godMode: true, spawnPaused: true, freezeEnemies: true, ...scene.cheats },
      autoPickUpgrades: true,
    },
  });

  const container = document.createElement("div");
  container.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#000";
  document.body.append(container);

  // Сундук с элиты остановил бы забег окном наград, а окна у стенда нет.
  useRun.subscribe((state) => {
    if (state.phase === "chest") useRun.getState().closeChest();
  });

  const ready = (async (): Promise<void> => {
    await useRun.getState().start({
      container,
      startingWeaponId: scene.startingWeaponId,
      mapId: DEFAULT_MAP_ID,
      difficultyId: DEFAULT_DIFFICULTY_ID,
    });
    await until(() => useRun.getState().phase === "running" || useRun.getState().phase === "paused", "забег не начался");
    useRun.getState().pause("manual");
    await until(() => useRun.getState().phase === "paused", "пауза");
    // Сцена создаётся после события старта: команды принимает только готовый мир.
    await until(() => useRun.getState().inspect() !== null, "мир не готов");
    for (const command of scene.commands) useRun.getState().devCommand(command);
    await twoFrames();
  })();

  window.__fxStand = {
    ready,
    scene,
    async step(ticks: number): Promise<void> {
      await ready;
      useRun.getState().devCommand({ kind: "stepTicks", ticks });
      await twoFrames();
    },
  };
}
