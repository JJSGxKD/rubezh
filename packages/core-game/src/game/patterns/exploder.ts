import { despawnEnemy, damagePlayer, type World } from "../sim/world";
import { pushSimEvent, SIM_EVENT } from "../sim/events";
import type { PatternBehavior } from "./behavior";
import { createHeading, headingToPlayer, stopEnemy } from "./steering";

export const EXPLODER_PHASE = {
  approach: 0,
  fuse: 1,
} as const;

const heading = createHeading();

/**
 * Подбегает, останавливается, мигает и взрывается по площади.
 *
 * Касанием не бьёт — урон только взрывом, и только если игрок не успел выйти
 * из радиуса за время фитиля. Убитый во время фитиля не взрывается: это и
 * есть награда за то, что игрок заметил угрозу.
 *
 * Взрыв не засчитывается игроку как убийство: врага убрал не игрок.
 */
export const exploder: PatternBehavior = {
  update(world, index, dtSec) {
    const enemies = world.enemies;
    const type = world.enemyTypes[enemies.type[index]];

    if (enemies.phase[index] === EXPLODER_PHASE.approach) {
      headingToPlayer(world, index, heading);
      if (heading.distance > type.params.triggerDistance) {
        enemies.vx[index] = heading.nx * type.speed;
        enemies.vy[index] = heading.ny * type.speed;
        return;
      }
      enemies.phase[index] = EXPLODER_PHASE.fuse;
      enemies.phaseTimer[index] = type.params.fuseSec;
    }

    stopEnemy(world, index);
    enemies.phaseTimer[index] -= dtSec;
    if (enemies.phaseTimer[index] <= 0) detonate(world, index);
  },
};

function detonate(world: World, index: number): void {
  const enemies = world.enemies;
  const typeIndex = enemies.type[index];
  const type = world.enemyTypes[typeIndex];
  const x = enemies.x[index];
  const y = enemies.y[index];

  const dx = world.player.x - x;
  const dy = world.player.y - y;
  const reach = type.params.blastRadius + world.config.player.radius;
  // Урон из слота, а не из типа: в нём застыл множитель сложности отрезка.
  if (dx * dx + dy * dy <= reach * reach) damagePlayer(world, enemies.damage[index], typeIndex);

  pushSimEvent(world.events, {
    kind: SIM_EVENT.explosion,
    x,
    y,
    radius: type.params.blastRadius,
    tick: world.stats.tick,
  });
  despawnEnemy(world, index);
}
