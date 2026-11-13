import { CONTENT_SNAPSHOT, type ContentSnapshot } from "../../src/content/snapshot";

/**
 * Карачун, который не придёт никогда: секунда за любым забегом. Правила остаются валидными
 * (`lateAtSec` обязан быть позже `fromSec`), поэтому мир собирается как обычно, а бот его не видит.
 */
const STALKER_NEVER_SEC = 1_000_000;

/**
 * Тот же контент без Карачуна: точка отсчёта калибровки (Р205, tasks/T-0424). Живёт в тесте, а не в
 * контенте: игре «выключенный Карачун» не нужен, он нужен только сравнению «с ним и без него».
 */
export function withoutStalker(content: ContentSnapshot = CONTENT_SNAPSHOT): ContentSnapshot {
  const appear = content.stalker.appear;
  return {
    ...content,
    stalker: { ...content.stalker, appear: { ...appear, fromSec: STALKER_NEVER_SEC, lateAtSec: STALKER_NEVER_SEC + 1 } },
  };
}
