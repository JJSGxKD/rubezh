import Phaser from "phaser";
import type { PlatformAdapter } from "@bh/shared-types";
import { MainScene } from "./game/MainScene";

export * from "./content/enemies";
export * from "./content/waves";
export * from "./content/upgrades";

export interface CreateGameOptions {
  /** id элемента-контейнера в разметке приложения */
  parent: string;
  /** seed забега; фиксируется в баг-репорте и позволяет его воспроизвести */
  seed?: number;
}

/**
 * Точка входа игры для любого apps/web-*. Платформа передаётся готовым
 * адаптером — core-game сам ничего не знает о платформе.
 */
export function createGame(adapter: PlatformAdapter, options: CreateGameOptions): Phaser.Game {
  const seed = options.seed ?? 1;
  const parentElement = document.getElementById(options.parent);
  const pixelRatio = devicePixelRatio();
  const initialSize = measureViewport(parentElement);

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: options.parent,
    backgroundColor: "#0d0f14",
    scale: {
      // Не RESIZE: этот режим берёт размер только у родителя, и если тот на
      // момент старта отдаёт ноль (WebView в момент открытия — обычное дело),
      // Phaser создаёт канву 0x0 и падает с "Framebuffer status: Incomplete
      // Attachment" ещё до первого кадра. Стартуем с заведомо ненулевого
      // размера и подстраиваемся сами, когда контейнер сообщит настоящий.
      mode: Phaser.Scale.NONE,
      // Канва создаётся в ФИЗИЧЕСКИХ пикселях, а на страницу выводится
      // уменьшенной в devicePixelRatio раз. Иначе на телефоне картинка
      // растягивается браузером и выглядит мыльной — на десктопе с DPR 1
      // этого просто не видно.
      width: initialSize.width * pixelRatio,
      height: initialSize.height * pixelRatio,
      zoom: 1 / pixelRatio,
    },
    scene: [],
  });

  game.scene.add("main", MainScene, true, { seed, unitScale: pixelRatio });

  followParentSize(game, parentElement, pixelRatio);

  // Ошибка авторизации не должна ронять игровой цикл: на неделях 1-2 бэкенда
  // нет вовсе, а стенд испытаний открывается и вне мессенджера
  // (docs/20-env-and-ports.md §4).
  adapter
    .init()
    .then((user) => console.log("Игрок авторизован:", user))
    .catch((error: unknown) => console.warn("Адаптер платформы недоступен:", error));

  return game;
}

/** Размер, с которым игра стартует. Ноль недопустим — см. комментарий выше. */
const FALLBACK_WIDTH = 800;
const FALLBACK_HEIGHT = 600;

function devicePixelRatio(): number {
  const ratio = globalThis.devicePixelRatio;
  return typeof ratio === "number" && ratio > 0 ? ratio : 1;
}

function measureViewport(parentElement: HTMLElement | null): {
  width: number;
  height: number;
} {
  const width = parentElement?.clientWidth || globalThis.innerWidth || 0;
  const height = parentElement?.clientHeight || globalThis.innerHeight || 0;

  return {
    width: width > 0 ? width : FALLBACK_WIDTH,
    height: height > 0 ? height : FALLBACK_HEIGHT,
  };
}

/**
 * Подгонка канвы под контейнер. Нулевые размеры игнорируются: контейнер может
 * отдать ноль при сворачивании приложения или в момент открытия мини-аппа, и
 * реагировать на это сменой размера канвы — верный способ уронить рендер.
 */
function followParentSize(
  game: Phaser.Game,
  parentElement: HTMLElement | null,
  pixelRatio: number,
): void {
  const apply = (): void => {
    const size = measureViewport(parentElement);
    const width = size.width * pixelRatio;
    const height = size.height * pixelRatio;
    if (width === game.scale.width && height === game.scale.height) return;
    game.scale.resize(width, height);
  };

  globalThis.addEventListener("resize", apply);
  globalThis.addEventListener("orientationchange", apply);

  if (parentElement !== null && typeof ResizeObserver !== "undefined") {
    new ResizeObserver(apply).observe(parentElement);
  }
}
