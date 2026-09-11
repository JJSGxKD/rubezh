import type { World } from "../sim/world";
import { vectorLength } from "../sim/vector";
import type { PatternBehavior } from "./behavior";
import { createHeading, headingToPlayer, MIN_HEADING_DISTANCE, stopEnemy } from "./steering";

export const ORBIT_PHASE = {
  /** только что появился: кольцо и направление вращения ещё не выбраны */
  fresh: 0,
  orbiting: 1,
} as const;

/**
 * Полоса вокруг кольца, в которой враг считается «на орбите». Внутри неё
 * кольцо сужается и враг идёт в основном по касательной; снаружи — в основном
 * сближается по спирали.
 */
const RING_BAND_UNITS = 30;

const heading = createHeading();

/**
 * Ходит кольцом вокруг игрока и сужает его — отрезает пути отхода.
 *
 * Без тригонометрии: касательная — это перпендикуляр к направлению на
 * игрока, а он считается перестановкой компонент. Тригонометрия приближённая
 * и расходится между JS-движками, а симуляция обязана давать одинаковый
 * исход на Android и iOS (docs/26-stage2-plan.md, WP4.5).
 */
export const orbit: PatternBehavior = {
  update(world, index, dtSec) {
    const enemies = world.enemies;
    const type = world.enemyTypes[enemies.type[index]];
    if (enemies.phase[index] === ORBIT_PHASE.fresh) enterOrbit(world, index);

    headingToPlayer(world, index, heading);
    if (heading.distance < MIN_HEADING_DISTANCE) {
      stopEnemy(world, index);
      return;
    }

    const band = RING_BAND_UNITS * world.config.unitScale;
    const radialError = heading.distance - enemies.ringRadius[index];
    if (Math.abs(radialError) <= band) {
      enemies.ringRadius[index] = Math.max(
        type.params.minRadius,
        enemies.ringRadius[index] - type.params.shrinkPerSec * dtSec,
      );
    }

    // heading указывает на игрока; касательная — поворот на 90° в сторону
    // вращения, радиальная поправка — к кольцу или от него.
    const spin = enemies.dirX[index];
    const inward = clamp(radialError / band, -1, 1);
    const desiredX = -heading.ny * spin + heading.nx * inward;
    const desiredY = heading.nx * spin + heading.ny * inward;
    const length = vectorLength(desiredX, desiredY);

    enemies.vx[index] = (desiredX / length) * type.speed;
    enemies.vy[index] = (desiredY / length) * type.speed;
  },
};

/**
 * Направление вращения выбирается генератором мира при первом обновлении, а
 * не при спавне: спавн не знает о паттернах, а порядок обращений к генератору
 * в шаге симуляции фиксирован — детерминизм сохраняется.
 */
function enterOrbit(world: World, index: number): void {
  const enemies = world.enemies;
  enemies.ringRadius[index] = world.enemyTypes[enemies.type[index]].params.orbitRadius;
  enemies.dirX[index] = world.rng.nextFloat() < 0.5 ? -1 : 1;
  enemies.phase[index] = ORBIT_PHASE.orbiting;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
