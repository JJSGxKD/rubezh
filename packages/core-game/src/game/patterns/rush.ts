import type { World } from "../sim/world";
import { vectorLength } from "../sim/vector";
import type { PatternBehavior } from "./behavior";
import { createHeading, enemySpeed, headingToPlayer, MIN_HEADING_DISTANCE } from "./steering";

export const RUSH_PHASE = {
  /** только что появился или закончил пробег: направление ещё не выбрано */
  aiming: 0,
  running: 1,
} as const;

const heading = createHeading();

/**
 * Проносится мимо игрока насквозь и уходит дальше.
 *
 * Все остальные враги так или иначе держат игрока: идут на него, кружат,
 * стреляют. Рой — единственный, кто не преследует вовсе: он берёт упреждение,
 * бежит по прямой и пробегает мимо, а через несколько секунд заходит на новый
 * круг. Давление от него не в том, что он догонит, а в том, что поперёк пути
 * отхода внезапно идёт стена тел.
 *
 * Направление фиксируется в момент прицеливания и дальше не меняется —
 * поэтому от роя можно уклониться, и это главное, что отличает его от роящихся
 * крыс.
 */
export const rush: PatternBehavior = {
  update(world, index, dtSec) {
    const enemies = world.enemies;
    const type = world.enemyTypes[enemies.type[index]];

    if (enemies.phase[index] === RUSH_PHASE.aiming) {
      aim(world, index);
      enemies.phase[index] = RUSH_PHASE.running;
      enemies.phaseTimer[index] = type.params.runSec;
      return;
    }

    enemies.phaseTimer[index] -= dtSec;
    // Пробег кончился — рой разворачивается и заходит снова. Скорость при
    // этом не сбрасывается: разворот на полном ходу читается как вираж.
    if (enemies.phaseTimer[index] <= 0) enemies.phase[index] = RUSH_PHASE.aiming;
  },
};

/**
 * Прицелиться с упреждением: рой идёт туда, где игрок окажется через
 * `leadSec`, а не туда, где он сейчас. Без упреждения бегущий игрок каждый раз
 * оказывался бы у роя за спиной, и тот пробегал бы впустую.
 */
function aim(world: World, index: number): void {
  const enemies = world.enemies;
  const player = world.player;
  const type = world.enemyTypes[enemies.type[index]];
  const lead = type.params.leadSec;

  const targetX = player.x + player.vx * lead;
  const targetY = player.y + player.vy * lead;
  const dx = targetX - enemies.x[index];
  const dy = targetY - enemies.y[index];
  const distance = vectorLength(dx, dy);

  const speed = enemySpeed(world, index);
  if (distance < MIN_HEADING_DISTANCE) {
    // Рой стоит ровно на игроке — редкий случай, но делить на ноль нельзя:
    // берём направление на игрока как есть.
    headingToPlayer(world, index, heading);
    enemies.vx[index] = heading.nx * speed;
    enemies.vy[index] = heading.ny * speed;
    return;
  }

  enemies.vx[index] = (dx / distance) * speed;
  enemies.vy[index] = (dy / distance) * speed;
}
