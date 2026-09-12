import Phaser from "phaser";
import type { PlatformAdapter } from "@bh/shared-types";
import { MainScene } from "./game/MainScene";
import type { BenchSceneData } from "./game/bench/types";

export * from "./content/enemies";
export * from "./content/waves";
export * from "./content/upgrades";
export * from "./content/weapons";
export * from "./game/bench";

// Прокачка внутри забега: оболочка приложения показывает варианты и
// возвращает выбор игрока (docs/27-design-system-and-app-shell.md §3.1).
export {
  chooseUpgrade,
  isAwaitingChoice,
  prepareOffers,
  xpForLevel,
  OFFERS_PER_LEVEL,
} from "./game/progression/levels";

export interface CreateGameOptions {
  /** id элемента-контейнера в разметке приложения */
  parent: string;
  /** seed забега; фиксируется в баг-репорте и позволяет его воспроизвести */
  seed?: number;
  /** стартовое оружие; по умолчанию — первое стартовое из контента */
  startingWeaponId?: string;
  /**
   * Ограничение частоты отрисовки.
   *
   * По умолчанию Phaser рисует со скоростью экрана: на 120-герцовом телефоне
   * это вдвое больше работы, чем на 60-герцовом, и замеры двух устройств
   * перестают быть сопоставимыми. Для прогонов, которые нужно сравнивать,
   * частота фиксируется.
   */
  renderCapFps?: number;
  /**
   * Режим стресс-испытания. Передаётся только сборкой со включённым стендом:
   * приложение решает, включать ли его, и оно же собирает сведения об
   * устройстве — движок про платформу ничего не знает (docs/01-tech-stack.md §1).
   */
  bench?: Omit<BenchSceneData, "seed">;
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
    // forceSetTimeOut уводит цикл с requestAnimationFrame на таймер — только
    // так Phaser позволяет ограничить частоту сверху. Цена — чуть менее
    // ровный ритм кадров, поэтому режим включается явно и только для замеров.
    ...(options.renderCapFps === undefined
      ? {}
      : { fps: { target: options.renderCapFps, forceSetTimeOut: true } }),
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

  if (options.bench === undefined) {
    game.scene.add("main", MainScene, true, {
      seed,
      unitScale: pixelRatio,
      ...(options.startingWeaponId === undefined
        ? {}
        : { startingWeaponId: options.startingWeaponId }),
    });
  } else {
    // Динамический импорт, а не обычный: стенд испытаний уезжает в отдельный
    // чанк и не тянется в основной бандл, который грузят игроки.
    const benchData: BenchSceneData = {
      ...options.bench,
      seed,
      // Плотность берётся отсюда, а не из замера приложения: канва создана
      // именно с этим множителем, и мир обязан считаться в тех же единицах.
      device: { ...options.bench.device, devicePixelRatio: pixelRatio },
    };
    void import("./game/BenchScene").then(({ BenchScene }) => {
      game.scene.add("bench", BenchScene, true, benchData);
    });
  }

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
