import { damageEnemy } from "../sim/combat";
import { vectorLength } from "../sim/vector";
import { MAX_PATTERN_RADIUS } from "../patterns";
import type { World } from "../sim/world";
import type { WeaponBehaviorImpl } from "./behavior";
import type { ResolvedWeaponLevel } from "./weapon-types";

/**
 * Радиус самого оберега в игровых единицах: он же и рисуется, чтобы задеть
 * можно было ровно тем, что видно. Оберег крупный намеренно — бьёт он только
 * касанием, и мелкий камень на кольце просто пролетал мимо всех.
 */
export const ORBITER_RADIUS = 16;

/** Больше шести оберегов на кольце не читается на экране телефона. */
export const MAX_ORBITERS = 6;

/**
 * Готовые направления для равномерной расстановки орбитеров по кольцу.
 * Числа — литералы, а не `Math.cos`: тригонометрия приближённая и расходится
 * между JS-движками (docs/26-stage2-plan.md, WP4.5).
 */
const RING_OFFSETS: readonly (readonly (readonly [number, number])[])[] = [
  [[1, 0]],
  [
    [1, 0],
    [-1, 0],
  ],
  [
    [1, 0],
    [-0.5, 0.8660254037844387],
    [-0.5, -0.8660254037844387],
  ],
  [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ],
  [
    [1, 0],
    [0.30901699437494745, 0.9510565162951535],
    [-0.8090169943749475, 0.5877852522924731],
    [-0.8090169943749475, -0.5877852522924731],
    [0.30901699437494745, -0.9510565162951535],
  ],
  [
    [1, 0],
    [0.5, 0.8660254037844386],
    [-0.5, 0.8660254037844386],
    [-1, 0],
    [-0.5, -0.8660254037844386],
    [0.5, -0.8660254037844386],
  ],
];

/**
 * Обереги кружат вокруг игрока и бьют всё, чего касаются. Пауза между
 * ударами кольца делится на число оберегов: количество камней — это скорость
 * кольца в уроне, а не только площадь.
 *
 * Кольцо держится на игроке и никуда не отстаёт: оберег, тянущийся следом на
 * бегу, читается как отдельная тварь за спиной, а не как своя защита.
 *
 * Вращение — доворот единичного вектора по перпендикуляру с нормировкой, а не
 * приращение угла: тот же запрет на тригонометрию. Цена — вращение чуть
 * медленнее заданного на больших шагах, и это ровно то же приближение, что у
 * любого шага симуляции по времени.
 */
export const orbit: WeaponBehaviorImpl = {
  update(world, slot, level, dtSec) {
    const weapon = world.loadout.weapons[slot];
    const radius = Math.max(level.areaRadius, 1);

    const angularStep = (level.projectileSpeed / radius) * dtSec;
    const nextX = weapon.dirX - weapon.dirY * angularStep;
    const nextY = weapon.dirY + weapon.dirX * angularStep;
    const length = vectorLength(nextX, nextY);
    if (length > 1e-6) {
      weapon.dirX = nextX / length;
      weapon.dirY = nextY / length;
    }

    if (weapon.cooldown > 0) {
      weapon.cooldown -= dtSec;
      return;
    }

    // Пауза делится на число оберегов: иначе лишний камень не добавлял урона
    // вовсе — общий откат съедал его. Кольцо из шести бьёт вшестеро чаще
    // одного, и «ещё один оберег» на карточке выбора значит ровно это.
    if (strikeTouched(world, slot, level)) weapon.cooldown = level.cooldownSec / orbiterCount(level);
  },
};

function strikeTouched(world: World, slot: number, level: ResolvedWeaponLevel): boolean {
  const count = orbiterCount(level);
  const reach = ORBITER_RADIUS * world.config.unitScale;
  let touched = false;

  for (let k = 0; k < count; k++) {
    orbiterPosition(world, slot, level, k, scratch);
    const found = world.enemyGrid.queryInto(
      scratch.x,
      scratch.y,
      reach + MAX_PATTERN_RADIUS * world.config.unitScale,
      world.queryBuffer,
    );

    for (let i = 0; i < found; i++) {
      const enemy = world.queryBuffer[i];
      if (world.enemies.alive[enemy] === 0) continue;

      const dx = world.enemies.x[enemy] - scratch.x;
      const dy = world.enemies.y[enemy] - scratch.y;
      const contact = reach + world.enemyTypes[world.enemies.type[enemy]].radius;
      if (dx * dx + dy * dy > contact * contact) continue;

      damageEnemy(world, enemy, level.damage, slot);
      touched = true;
    }
  }
  return touched;
}

export interface OrbiterPoint {
  x: number;
  y: number;
}

const scratch: OrbiterPoint = { x: 0, y: 0 };

export function orbiterCount(level: ResolvedWeaponLevel): number {
  return Math.min(MAX_ORBITERS, Math.max(1, Math.round(level.projectiles)));
}

/**
 * Позиция k-го оберега. Нужна и симуляции, и рендеру: обереги не живут в пуле
 * снарядов, их положение полностью задаётся состоянием оружия.
 */
export function orbiterPosition(
  world: World,
  slot: number,
  level: ResolvedWeaponLevel,
  index: number,
  out: OrbiterPoint,
): void {
  const weapon = world.loadout.weapons[slot];
  const count = orbiterCount(level);
  const offsets = RING_OFFSETS[count - 1];
  const offset = offsets[Math.min(index, offsets.length - 1)];

  // Поворот базового направления на фиксированную долю оборота.
  const dirX = weapon.dirX * offset[0] - weapon.dirY * offset[1];
  const dirY = weapon.dirX * offset[1] + weapon.dirY * offset[0];

  out.x = world.player.x + dirX * level.areaRadius;
  out.y = world.player.y + dirY * level.areaRadius;
}
