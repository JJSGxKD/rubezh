import type Phaser from "phaser";
import type { StalkerPhase } from "../sim/stalker";
import { TICK_HZ, type World } from "../sim/world";
import { UNKILLABLE_LOOK } from "./looks";
import { lerp } from "./textures";

/**
 * Облик неубиваемого на канве (Р205, tasks/T-0425): предвестие инеем на земле, провал под ногами и
 * растворение. Сама фигура — `hood` в `shapes.ts`, цвета — `UNKILLABLE_LOOK` в `looks.ts`.
 *
 * Предвестие и провал — чтение боя, а не украшение: игрок должен видеть, откуда Карачун выйдет, и узнавать
 * его, поэтому рисуются при любых настройках графики (выключатели «Телеграфов» и «Эффектов оружия» их не
 * касаются), как кольцо предупреждения осады.
 *
 * Прогресс считается из таймеров мира: рендер их только читает, и на исход забега ничего не влияет. На паузе
 * всё замирает вместе с миром. Анимируются только позиция, масштаб и прозрачность спрайтов; все текстуры
 * создаются при старте, а не в кадре. Спрайтов фиксированное число: Карачун в мире один.
 */

/** Предвестие рисуется только в фазе `omen`; выключатели графики его не гасят — это чтение боя. */
export function omenDrawn(phase: StalkerPhase, _switches: { telegraphs: boolean; weaponEffects: boolean }): boolean {
  return phase === "omen";
}

/** Доля фазы предвестия, которая прошла: 0 в начале, 1 в конце. `phaseTicks` убывает от `omenTicks` до нуля. */
export function omenProgress(phaseTicks: number, omenTicks: number): number {
  if (omenTicks <= 0) return 1;
  const p = 1 - phaseTicks / omenTicks;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

export interface OmenView {
  /** точка выхода, мировые координаты */
  x: number;
  y: number;
  progress: number;
}

/** Предвестие мира; `null` — сейчас не фаза `omen` или правил появления нет. */
export function omenView(world: World): OmenView | null {
  const state = world.stalker;
  const appear = state.appear;
  if (appear === null || state.phase !== "omen") return null;
  return { x: state.x, y: state.y, progress: omenProgress(state.phaseTicks, Math.round(appear.omenSec * TICK_HZ)) };
}

/** Прозрачность тела в фазе растворения: 1 в начале, 0 в конце. `phaseTicks` убывает от `fadeTicks` до нуля. */
export function fadeAlpha(phaseTicks: number, fadeTicks: number): number {
  if (fadeTicks <= 0) return 0;
  const a = phaseTicks / fadeTicks;
  return a < 0 ? 0 : a > 1 ? 1 : a;
}

/** Прозрачность тела и провала Карачуна в этом кадре: в фазе `fading` убывает за `fadeSec`, иначе 1. */
export function stalkerFadeAlpha(world: World): number {
  const state = world.stalker;
  const appear = state.appear;
  if (appear === null || state.phase !== "fading") return 1;
  return fadeAlpha(state.phaseTicks, Math.max(1, Math.round(appear.fadeSec * TICK_HZ)));
}

/** Масштаб пятна тумана к полному (три радиуса тела): растёт от 0,4 до 1,2. */
export function omenFogScale(progress: number): number {
  return 0.4 + 0.8 * progress;
}

/** Длина луча инея в долях наибольшей: растёт с прогрессом. */
export function omenRayLength(progress: number): number {
  return 0.2 + 0.8 * progress;
}

/** Прозрачность инея: к концу предвестия ярче. */
export function omenRayAlpha(progress: number): number {
  return 0.35 + 0.65 * progress;
}

/** Туман при выходе рассеивается за 0,3 с. */
export const DISSOLVE_TICKS = Math.round(0.3 * TICK_HZ);

/** Рассеивание: масштаб растёт от конечного масштаба предвестия, прозрачность идёт к нулю. */
export function dissolveView(progress: number): { scale: number; alpha: number } {
  const p = progress < 0 ? 0 : progress > 1 ? 1 : progress;
  return { scale: omenFogScale(1) * (1 + 0.35 * p), alpha: 1 - p };
}

/** Полный радиус тумана — три радиуса тела (масштаб 1). */
const FOG_RADIUS_MUL = 3;
/** Бледный эллипс на земле сплюснут по `y`: земля видна под углом. */
const FLATTEN = 0.42;
/** Лучи инея: угол в градусах и доля наибольшей длины — трещина-звезда, а не правильные спицы. */
const RAYS: readonly (readonly [number, number])[] = [
  [8, 1],
  [52, 0.72],
  [101, 0.9],
  [157, 1],
  [204, 0.7],
  [263, 0.85],
  [313, 0.95],
];
/** Наибольшая длина луча в радиусах тела. */
const RAY_MAX_RADII = 2.5;

const FOG_KEY = "bh-stalker-fog";
const RAY_KEY = "bh-stalker-frost-ray";
const PIT_KEY = "bh-stalker-pit";

/** Провал под ногами и предвестие Карачуна: спрайты из фиксированного набора, `sync` раз в кадр. */
export class StalkerLook {
  private readonly world: World;
  private readonly enabled: boolean;
  private readonly container: Phaser.GameObjects.Container;
  private readonly fog: Phaser.GameObjects.Image | null = null;
  private readonly pit: Phaser.GameObjects.Image | null = null;
  private readonly rays: Phaser.GameObjects.Image[] = [];
  /** поворот и доля длины каждого луча: считаются один раз */
  private readonly rayRotation: number[] = [];
  private readonly rayLengthMul: number[] = [];
  private readonly bodyRadius: number;
  private readonly rayMaxPx: number;
  /** предыдущий кадр был предвестием — по выходу из фазы запускается рассеивание */
  private wasOmen = false;
  private lastX = 0;
  private lastY = 0;
  /** тик начала рассеивания; −1 — тумана нет */
  private dissolveStart = -1;

  constructor(scene: Phaser.Scene, world: World, layer: Phaser.GameObjects.Container) {
    this.world = world;
    this.container = scene.add.container(0, 0);
    layer.add(this.container);

    const typeIndex = world.stalkerBody.typeIndex;
    this.enabled = typeIndex >= 0;
    this.bodyRadius = this.enabled ? world.enemyTypes[typeIndex].radius : 0;
    this.rayMaxPx = Math.max(8, Math.ceil(this.bodyRadius * RAY_MAX_RADII));
    if (!this.enabled) return;

    ensureFogTexture(scene, this.bodyRadius);
    ensureRayTexture(scene, this.bodyRadius, this.rayMaxPx);
    ensurePitTexture(scene, this.bodyRadius);

    this.pit = scene.add.image(0, 0, PIT_KEY).setVisible(false);
    this.fog = scene.add.image(0, 0, FOG_KEY).setVisible(false);
    this.container.add([this.pit, this.fog]);
    for (const [degrees, mul] of RAYS) {
      // Перспектива: земля сплюснута, поэтому и лучи идут по эллипсу, а не по окружности.
      const radians = (degrees * Math.PI) / 180;
      const dx = Math.cos(radians);
      const dy = Math.sin(radians) * FLATTEN;
      this.rayRotation.push(Math.atan2(dy, dx));
      this.rayLengthMul.push(mul * Math.sqrt(dx * dx + dy * dy));
      const ray = scene.add.image(0, 0, RAY_KEY).setOrigin(0, 0.5).setVisible(false);
      this.container.add(ray);
      this.rays.push(ray);
    }
  }

  /** Раз в кадр: предвестие, рассеивание тумана и провал под ногами. `t` — доля до следующего шага симуляции. */
  sync(t: number): void {
    if (!this.enabled) return;
    const world = this.world;
    const tick = world.stats.tick;

    const omen = omenView(world);
    if (omen !== null) {
      this.wasOmen = true;
      this.dissolveStart = -1;
      this.lastX = omen.x;
      this.lastY = omen.y;
      this.drawFog(omen.x, omen.y, omenFogScale(omen.progress), 0.6 + 0.4 * omen.progress, omenRayLength(omen.progress), omenRayAlpha(omen.progress));
    } else {
      // Туман рассеивается, когда Карачун вышел; срезанное или оборванное предвестие просто исчезает.
      if (this.wasOmen && world.stalker.phase === "chase") this.dissolveStart = tick;
      this.wasOmen = false;
      const age = this.dissolveStart < 0 ? -1 : tick - this.dissolveStart;
      if (age >= 0 && age < DISSOLVE_TICKS) {
        const view = dissolveView(age / DISSOLVE_TICKS);
        this.drawFog(this.lastX, this.lastY, view.scale, 0.9 * view.alpha, 1, view.alpha);
      } else {
        this.dissolveStart = -1;
        this.hideFog();
      }
    }

    this.syncPit(t);
  }

  private drawFog(x: number, y: number, scale: number, alpha: number, rayLength: number, rayAlpha: number): void {
    const fog = this.fog;
    if (fog === null) return;
    fog.setPosition(x, y).setScale(scale).setAlpha(alpha).setVisible(true);
    for (let k = 0; k < this.rays.length; k++) {
      this.rays[k]
        .setPosition(x, y)
        .setRotation(this.rayRotation[k])
        .setScale(rayLength * this.rayLengthMul[k], 1)
        .setAlpha(rayAlpha)
        .setVisible(true);
    }
  }

  private hideFog(): void {
    if (this.fog?.visible === true) this.fog.setVisible(false);
    for (const ray of this.rays) if (ray.visible) ray.setVisible(false);
  }

  /** Провал — вместо тени под ногами живого Карачуна; гаснет вместе с телом. */
  private syncPit(t: number): void {
    const pit = this.pit;
    if (pit === null) return;
    const world = this.world;
    const slot = world.stalkerBody.slot;
    const enemies = world.enemies;
    if (slot < 0 || enemies.alive[slot] === 0 || enemies.type[slot] !== world.stalkerBody.typeIndex) {
      if (pit.visible) pit.setVisible(false);
      return;
    }
    pit.setPosition(lerp(enemies.prevX[slot], enemies.x[slot], t), lerp(enemies.prevY[slot], enemies.y[slot], t) + this.bodyRadius * PIT_DROP).setAlpha(stalkerFadeAlpha(world)).setVisible(true);
  }
}

/** Насколько ниже центра тела лежит провал, в радиусах: под подолом, где у фигуры «ног нет». */
const PIT_DROP = 0.9;

function ensureFogTexture(scene: Phaser.Scene, bodyRadius: number): void {
  if (scene.textures.exists(FOG_KEY)) return;
  const rx = bodyRadius * FOG_RADIUS_MUL;
  const ry = rx * FLATTEN;
  const width = Math.ceil(rx * 2) + 2;
  const height = Math.ceil(ry * 2) + 2;
  const cx = width / 2;
  const cy = height / 2;
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
  // Бледный ореол, тёмное пятно тумана и прерывистое бледное кольцо — как в karachun-omen.svg.
  graphics.fillStyle(UNKILLABLE_LOOK.pit.ring, 0.1);
  graphics.fillEllipse(cx, cy, rx * 2, ry * 2);
  graphics.fillStyle(UNKILLABLE_LOOK.deep, 0.5);
  graphics.fillEllipse(cx, cy, rx * 2 * 0.757, ry * 2 * 0.757);
  graphics.lineStyle(Math.max(1, bodyRadius * 0.1), UNKILLABLE_LOOK.pit.ring, 0.7);
  const dashes = 12;
  const steps = 5;
  for (let d = 0; d < dashes; d++) {
    graphics.beginPath();
    for (let s = 0; s <= steps; s++) {
      // Штрих занимает три четверти шага, остальное — просвет.
      const angle = ((d + (0.75 * s) / steps) / dashes) * Math.PI * 2;
      const x = cx + Math.cos(angle) * rx * 0.847;
      const y = cy + Math.sin(angle) * ry * 0.847;
      if (s === 0) graphics.moveTo(x, y);
      else graphics.lineTo(x, y);
    }
    graphics.strokePath();
  }
  graphics.generateTexture(FOG_KEY, width, height);
  graphics.destroy();
}

/** Луч инея: острие от центра наружу и две веточки; длину на экране задаёт масштаб по `x`. */
function ensureRayTexture(scene: Phaser.Scene, bodyRadius: number, length: number): void {
  if (scene.textures.exists(RAY_KEY)) return;
  const half = Math.max(3, Math.ceil(bodyRadius * 0.4));
  const base = Math.max(1.5, bodyRadius * 0.1);
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
  graphics.fillStyle(UNKILLABLE_LOOK.frost, 1);
  graphics.fillTriangle(0, half - base, length, half, 0, half + base);
  graphics.lineStyle(Math.max(1, base * 0.7), UNKILLABLE_LOOK.frost, 1);
  const fork = length * 0.55;
  graphics.lineBetween(fork, half, fork + length * 0.2, half - half * 0.8);
  graphics.lineBetween(fork, half, fork + length * 0.2, half + half * 0.8);
  graphics.generateTexture(RAY_KEY, Math.ceil(length), half * 2);
  graphics.destroy();
}

/** Провал: тёмный эллипс с бледным кольцом, как под фигурой в karachun.svg. */
function ensurePitTexture(scene: Phaser.Scene, bodyRadius: number): void {
  if (scene.textures.exists(PIT_KEY)) return;
  const rx = bodyRadius * 0.9;
  const ry = rx * 0.3;
  const width = Math.ceil(rx * 2) + 4;
  const height = Math.ceil(ry * 2) + 4;
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
  graphics.fillStyle(UNKILLABLE_LOOK.pit.color, 0.6);
  graphics.fillEllipse(width / 2, height / 2, rx * 2 * 0.88, ry * 2 * 0.88);
  graphics.lineStyle(Math.max(1, bodyRadius * 0.08), UNKILLABLE_LOOK.pit.ring, 0.6);
  graphics.strokeEllipse(width / 2, height / 2, rx * 2, ry * 2);
  graphics.generateTexture(PIT_KEY, width, height);
  graphics.destroy();
}
