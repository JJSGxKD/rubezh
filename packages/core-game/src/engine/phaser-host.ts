import Phaser from "phaser";

/**
 * Игра Phaser, подогнанная под контейнер оболочки.
 *
 * Вынесено из точки входа: забег и стенд испытаний создают движок одинаково,
 * а отличаются только сценой. Здесь же живут две вещи, на которых проще всего
 * обжечься во встроенном WebView, — нулевой размер контейнера и плотность
 * пикселей.
 */
export interface PhaserHost {
  game: Phaser.Game;
  /** физических пикселей на CSS-пиксель — мир считается в них */
  pixelRatio: number;
  destroy(): void;
}

export interface PhaserHostOptions {
  container: HTMLElement;
  /** по умолчанию — плотность экрана устройства */
  pixelRatio?: number;
  /**
   * Ограничение частоты отрисовки. По умолчанию Phaser рисует со скоростью
   * экрана: на 120-герцовом телефоне это вдвое больше работы, чем на
   * 60-герцовом, и замеры двух устройств перестают быть сопоставимыми.
   */
  renderCapFps?: number;
  /** браузер отобрал контекст WebGL: картинка замрёт, и об этом надо сказать */
  onContextLost?: (reason: string) => void;
}

/** Размер, с которым игра стартует, если контейнер ещё отдаёт ноль. */
const FALLBACK_WIDTH = 800;
const FALLBACK_HEIGHT = 600;

export function createPhaserHost(options: PhaserHostOptions): PhaserHost {
  const pixelRatio = options.pixelRatio ?? devicePixelRatio();
  const size = measure(options.container);
  removeLeftoverCanvases(options.container);

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: options.container,
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
      // уменьшенной в pixelRatio раз. Иначе на телефоне картинка
      // растягивается браузером и выглядит мыльной.
      width: size.width * pixelRatio,
      height: size.height * pixelRatio,
      zoom: 1 / pixelRatio,
    },
    scene: [],
  });

  const stopFollowing = followContainerSize(game, options.container, pixelRatio);
  const stopWatchingContext = watchContextLoss(game, options.onContextLost);

  return {
    game,
    pixelRatio,
    destroy(): void {
      stopFollowing();
      stopWatchingContext();
      // `true` убирает канву из разметки: контейнером владеет оболочка, и
      // оставленная канва легла бы поверх следующего забега.
      game.destroy(true);
    },
  };
}

/**
 * Убрать канвы, оставшиеся от прошлой игры.
 *
 * Их быть не должно: у каждой игры есть владелец, который её уничтожает. Но
 * забытая канва — это живой контекст WebGL, а браузер держит их ограниченное
 * число и молча убивает самый старый. Выглядит это как замершая картинка при
 * живом HUD, и ищется потом дольше, чем стоит эта проверка.
 */
function removeLeftoverCanvases(container: HTMLElement): void {
  for (const canvas of Array.from(container.querySelectorAll("canvas"))) canvas.remove();
}

/**
 * Потеря контекста WebGL. Сама по себе она не ошибка приложения — так
 * браузер освобождает память, — но игрок видит замершую картинку, и молчать
 * об этом нельзя: без сообщения баг выглядит как «игра сломалась».
 */
function watchContextLoss(game: Phaser.Game, onLost?: (reason: string) => void): () => void {
  const canvas = game.canvas;
  if (canvas === null || canvas === undefined) return () => undefined;

  const handler = (event: Event): void => {
    // Отмена события даёт браузеру шанс восстановить контекст.
    event.preventDefault();
    onLost?.("контекст WebGL потерян");
  };
  canvas.addEventListener("webglcontextlost", handler);
  return () => canvas.removeEventListener("webglcontextlost", handler);
}

function devicePixelRatio(): number {
  const ratio = globalThis.devicePixelRatio;
  return typeof ratio === "number" && ratio > 0 ? ratio : 1;
}

function measure(container: HTMLElement): { width: number; height: number } {
  const width = container.clientWidth || globalThis.innerWidth || 0;
  const height = container.clientHeight || globalThis.innerHeight || 0;
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
function followContainerSize(
  game: Phaser.Game,
  container: HTMLElement,
  pixelRatio: number,
): () => void {
  const apply = (): void => {
    const size = measure(container);
    const width = size.width * pixelRatio;
    const height = size.height * pixelRatio;
    if (width === game.scale.width && height === game.scale.height) return;
    game.scale.resize(width, height);
  };

  globalThis.addEventListener("resize", apply);
  globalThis.addEventListener("orientationchange", apply);

  const observer =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
  observer?.observe(container);

  return () => {
    globalThis.removeEventListener("resize", apply);
    globalThis.removeEventListener("orientationchange", apply);
    observer?.disconnect();
  };
}
