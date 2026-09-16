import type { BossSnapshot } from "../../run-api";
import { isBoss } from "../patterns";
import type { World } from "../sim/world";

/**
 * Полоса здоровья босса (docs/27-design-system-and-app-shell.md §3.3).
 *
 * Фазы считаются от остатка здоровья, а не от времени: полоса на экране и
 * поведение босса должны говорить одно и то же. Порог перейдён — игрок видит
 * это и на полосе, и по тому, что босс начал бить чаще.
 *
 * Фаза — общее понятие ранга, а не свойство конкретного паттерна: матрёшка
 * рассыпается по тем же порогам, по которым кастер ускоряется.
 */
export const BOSS_PHASES = 3;

/** Фаза по доле оставшегося здоровья: 0 — полон сил, 2 — добивается. */
export function bossPhase(hpRatio: number): number {
  if (hpRatio > 0.66) return 0;
  return hpRatio > 0.33 ? 1 : 2;
}

/** Фаза живого врага — зовут и паттерны, и HUD, чтобы не разойтись. */
export function bossPhaseOf(world: World, index: number): number {
  const maxHp = world.enemies.maxHp[index];
  return maxHp > 0 ? bossPhase(world.enemies.hp[index] / maxHp) : 0;
}

/**
 * Босс на поле для HUD. Если их вдруг двое, берётся самый живучий: полоса
 * одна, и показывать она должна того, кто определяет бой.
 */
export function buildBossSnapshot(world: World): BossSnapshot | null {
  const enemies = world.enemies;
  let best = -1;

  for (let i = 0; i < enemies.count; i++) {
    if (enemies.alive[i] === 0) continue;
    if (!isBoss(world.enemyTypes[enemies.type[i]])) continue;
    if (best < 0 || enemies.hp[i] > enemies.hp[best]) best = i;
  }
  if (best < 0) return null;

  return {
    enemyId: world.enemyTypes[enemies.type[best]].id,
    hp: enemies.hp[best],
    maxHp: enemies.maxHp[best],
    phase: bossPhaseOf(world, best),
    phases: BOSS_PHASES,
  };
}
