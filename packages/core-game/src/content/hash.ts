import { DIFFICULTIES } from "./difficulty";
import { DROPS } from "./drops";
import { ENEMIES } from "./enemies";
import { MAPS } from "./maps";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "./upgrades";
import { ENDLESS_CURVE, TIMELINE } from "./waves";
import { WEAPONS } from "./weapons";

/**
 * Отпечаток игрового контента — версия баланса одним коротким числом.
 *
 * Он уезжает в итог забега и оттуда в аналитику: без него правку баланса не
 * отделить от сезонности, и вопрос «стали ли забеги короче после вчерашней
 * правки скорости роя» остаётся без ответа (docs/22-analytics-and-metrics.md
 * §5.3, docs/26-stage2-plan.md, WP4.4).
 *
 * Считается один раз при загрузке модуля: контент — это литералы в исходниках,
 * между забегами он не меняется.
 */
export const CONTENT_HASH = hashContent();

function hashContent(): string {
  // Порядок сознательно фиксирован: JSON.stringify сохраняет порядок полей
  // объекта, а массивы контента и так упорядочены. Перестановка врагов в файле
  // меняет отпечаток — и это правильно: от порядка зависят индексы типов, а
  // значит и последовательность обращений к генератору.
  const source = JSON.stringify([
    ENEMIES,
    WEAPONS,
    PASSIVES,
    LEVEL_CURVE,
    LOADOUT_LIMITS,
    TIMELINE,
    ENDLESS_CURVE,
    MAPS,
    DROPS,
    DIFFICULTIES,
  ]);

  // FNV-1a: короткая, без зависимостей и без криптографических претензий.
  // Задача — различать версии контента, а не защищаться от подделки: итог
  // забега считает клиент, и для сервера это в любом случае заявление игрока,
  // а не факт (docs/15-engineering-standards.md §7.1).
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
