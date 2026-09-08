import type { EnemyPattern } from "@bh/shared-types";

/**
 * Реализация паттернов поведения врагов. Новый паттерн — код, добавляет
 * участник 1 (или напарник, если решит писать TS напрямую).
 * Геймдизайнер использует уже существующие паттерны через content/enemies.ts,
 * сюда не заходит. См. docs/01-tech-stack.md §9.
 */
export interface EnemyBehavior {
  update(deltaMs: number): void;
}

export function createBehavior(pattern: EnemyPattern): EnemyBehavior {
  switch (pattern) {
    case "swarm":
      // TODO неделя 1: двигаться прямо к игроку, ничего сложнее
      return { update: () => {} };
    case "chase":
      // TODO неделя 1: медленное, но настойчивое преследование
      return { update: () => {} };
    case "kite_and_shoot":
      // TODO неделя 2: держать дистанцию + стрелять с интервалом
      return { update: () => {} };
  }
}
