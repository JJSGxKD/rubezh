import { CONTENT_SNAPSHOT, type ContentSnapshot } from "../../src/content/snapshot";

/**
 * Контент боя до T-0388 (Р194): `hpMul` и `xpMul` ступеней, рост здоровья бесконечной кривой и
 * рост поздних уровней. Нужен калибровке стойки: стоящий бот на этих числах обязан жить не
 * меньше, чем живой игрок (Р196). Подмена в самой калибровке — файлы контента не правятся, и
 * правка нынешних чисел эту точку отсчёта не двигает.
 */
const HP_MUL_BEFORE = [1, 1.9, 3.6, 5, 7, 9.5] as const;
const XP_MUL_BEFORE = [1, 2, 4, 6, 9, 13] as const;
const HP_GROWTH_BEFORE = 1.14;
const LATE_GROWTH_BEFORE = 1.12;

export function contentBeforeT0388(): ContentSnapshot {
  const base = CONTENT_SNAPSHOT;
  const late = base.levelCurve.late;
  if (late === undefined) throw new Error("В кривой опыта нет поздних уровней: нечего подменять");
  return {
    ...base,
    stages: base.stages.map((stage, i) => ({ ...stage, hpMul: HP_MUL_BEFORE[i] ?? stage.hpMul, xpMul: XP_MUL_BEFORE[i] ?? stage.xpMul })),
    endlessCurve: { ...base.endlessCurve, hpGrowth: HP_GROWTH_BEFORE },
    levelCurve: { ...base.levelCurve, late: { ...late, growth: LATE_GROWTH_BEFORE } },
  };
}
