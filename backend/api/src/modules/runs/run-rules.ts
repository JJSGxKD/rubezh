/**
 * Правила игры, которые нужны серверу для проверки забега
 * (docs/34-stage3-plan.md, WP4).
 *
 * Это копия чисел из контента `core-game`, а не импорт: собранный бэкенд не
 * импортирует исходники пакетов монорепо — по той же причине отдельно живёт
 * словарь событий (docs/22-analytics-and-metrics.md §3.3). Разойтись с
 * контентом копия не может молча: `scripts/test/run-rules.test.ts` сверяет её
 * с `LOADOUT_LIMITS` и списком сложностей и падает, называя число.
 *
 * Это правила, а не пороги антифрода: сколько слотов под оружие, знает любой,
 * кто играл. Пороги — в конфигурации (`app-config.ts`, `RUNS_*`).
 */

export const DIFFICULTIES = ["easy", "normal", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** Сколько оружий может быть у игрока одновременно (`LOADOUT_LIMITS.weapons`). */
export const MAX_WEAPONS = 3;
