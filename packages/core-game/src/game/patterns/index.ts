import type { EnemyPattern } from "@bh/shared-types";
import type { World } from "../sim/world";
import type { PatternBehavior } from "./behavior";
import { chase } from "./chase";
import { dash } from "./dash";
import { exploder } from "./exploder";
import { kiteAndShoot } from "./kite-and-shoot";
import { orbit } from "./orbit";
import { rush } from "./rush";
import { splitter } from "./splitter";
import { swarm } from "./swarm";

/**
 * Реестр паттернов поведения врагов. Новый паттерн — это код, его добавляет
 * участник 1. Геймдизайнер выбирает готовый паттерн и крутит его параметры в
 * content/enemies.ts и сюда не заходит (docs/01-tech-stack.md §9).
 *
 * Паттерны работают поверх пулов симуляции и не знают про Phaser: рендер
 * отделён от логики, иначе симуляцию нельзя прогнать headless
 * (docs/17-testing-strategy.md §3.0).
 */
export const PATTERNS: Record<EnemyPattern, PatternBehavior> = {
  swarm,
  chase,
  kite_and_shoot: kiteAndShoot,
  dash,
  orbit,
  exploder,
  splitter,
  rush,
};

export function applyPattern(
  pattern: EnemyPattern,
  world: World,
  index: number,
  dtSec: number,
): void {
  PATTERNS[pattern].update(world, index, dtSec);
}

/** Реакция паттерна на убийство врага игроком — например, распад на части. */
export function onEnemyKilled(pattern: EnemyPattern, world: World, index: number): void {
  PATTERNS[pattern].onDeath?.(world, index);
}

/** Список реализованных паттернов — на него опирается тест контента (§3.1). */
export const IMPLEMENTED_PATTERNS = Object.keys(PATTERNS) as EnemyPattern[];

export type { PatternBehavior } from "./behavior";
export { DASH_PHASE } from "./dash";
export { ORBIT_PHASE } from "./orbit";
export { EXPLODER_PHASE } from "./exploder";
export { RUSH_PHASE } from "./rush";
export {
  findEnemyContentProblems,
  MAX_PATTERN_RADIUS,
  PATTERN_TRAITS,
  type EnemyType,
  type PatternTraits,
  type ResolvedPatternParams,
} from "./enemy-types";
