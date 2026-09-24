import type { ContinueDef } from "@bh/shared-types";
import { despawnEnemy, despawnProjectile, MAX_CONTINUES_PER_RUN, TICK_SEC, type World } from "./world";

/**
 * Второй шанс — продолжение забега после смерти
 * (docs/07-monetization-and-ads.md §8). Это **команда миру**, а не правка
 * оболочкой: она применяется на границе тика, когда шаг не идёт, и пишется в
 * запись забега — иначе повтор разошёлся бы с оригиналом
 * (docs/28-diagnostics.md §3.4).
 *
 * Враги и их снаряды убираются **без добычи** и без убийств в статистике:
 * иначе второй шанс приносил бы опыт горстью и был бы выгоднее, чем не
 * умирать. Следующие враги подходят с кольца спавна как обычно — таймлайн
 * продолжается с той же секунды.
 */

export function canContinue(world: World): boolean {
  return !world.player.alive && world.stats.continuesUsed < world.continueRules.perRun;
}

/** `false` — продолжать нечего: игрок жив или продолжения за забег кончились. */
export function applyContinue(world: World): boolean {
  if (!canContinue(world)) return false;

  const enemies = world.enemies;
  for (let i = 0; i < enemies.count; i++) {
    if (enemies.alive[i] === 1) despawnEnemy(world, i);
  }
  const projectiles = world.projectiles;
  for (let i = 0; i < projectiles.count; i++) {
    if (projectiles.alive[i] === 1 && projectiles.fromPlayer[i] === 0) despawnProjectile(world, i);
  }

  const rules = world.continueRules;
  const player = world.player;
  player.alive = true;
  // Хотя бы единица здоровья: доля от крошечного максимума не должна вернуть
  // игрока мёртвым.
  player.hp = Math.max(1, world.playerStats.maxHp * rules.restoreHpRatio);
  player.invulnerableTicks = Math.round(rules.invulnerableSec / TICK_SEC);
  world.stats.deathCauseType = -1;
  world.stats.continueTicks[world.stats.continuesUsed] = world.stats.tick;
  world.stats.continuesUsed++;
  return true;
}

/** Секунды забега, на которых игрок продолжал, — в итог забега. */
export function continueSeconds(world: World): number[] {
  return Array.from(world.stats.continueTicks.subarray(0, world.stats.continuesUsed), (tick) => tick * TICK_SEC);
}

/** Ошибки в числах второго шанса — с именем поля, как у остального контента. */
export function findContinueProblems(rules: ContinueDef): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(rules.perRun) || rules.perRun < 0 || rules.perRun > MAX_CONTINUES_PER_RUN) {
    problems.push(`continue.perRun: целое от 0 до ${MAX_CONTINUES_PER_RUN}, а не ${rules.perRun}`);
  }
  if (!(rules.restoreHpRatio > 0 && rules.restoreHpRatio <= 1)) {
    problems.push(`continue.restoreHpRatio: больше 0 и не больше 1, а не ${rules.restoreHpRatio}`);
  }
  if (!(rules.invulnerableSec >= 0 && rules.invulnerableSec <= 10)) {
    problems.push(`continue.invulnerableSec: от 0 до 10 секунд, а не ${rules.invulnerableSec}`);
  }
  return problems;
}
