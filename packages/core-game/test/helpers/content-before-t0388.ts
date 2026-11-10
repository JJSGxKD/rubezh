import { CONTENT_SNAPSHOT, type ContentSnapshot } from "../../src/content/snapshot";
import { SIEGE } from "../../src/content/siege";

/**
 * Контент боя до T-0388 (Р194): `hpMul` и `xpMul` ступеней, рост здоровья бесконечной кривой и
 * рост поздних уровней. Нужен калибровке стойки: стоящий бот на этих числах обязан жить не
 * меньше, чем живой игрок (Р196). Подмена в самой калибровке — файлы контента не правятся, и
 * правка нынешних чисел эту точку отсчёта не двигает. Осада стоящего (T-0392) выключена: свойство
 * «бот не слабее человека» относится к калибровке бота без неё.
 */
const HP_MUL_BEFORE = [1, 1.9, 3.6, 5, 7, 9.5] as const;
const XP_MUL_BEFORE = [1, 2, 4, 6, 9, 13] as const;
const HP_GROWTH_BEFORE = 1.14;
const LATE_GROWTH_BEFORE = 1.12;

/**
 * Осада, которая не наступит никогда: секунда за любым забегом. Правила остаются валидными (проверка
 * ловит только отрицательные и нечисловые), поэтому мир собирается как обычно, а стоящий бот осады не видит.
 */
const SIEGE_NEVER_SEC = 1_000_000_000;

/** Тот же контент без осады стоящего: точка отсчёта «бегает» и калибровки бота до осады (T-0392). */
export function withoutSiege(content: ContentSnapshot = CONTENT_SNAPSHOT): ContentSnapshot {
  return { ...content, siege: { ...SIEGE, fromSec: SIEGE_NEVER_SEC } };
}

export function contentBeforeT0388(): ContentSnapshot {
  const base = CONTENT_SNAPSHOT;
  const late = base.levelCurve.late;
  if (late === undefined) throw new Error("В кривой опыта нет поздних уровней: нечего подменять");
  return {
    ...withoutSiege(base),
    stages: base.stages.map((stage, i) => ({ ...stage, hpMul: HP_MUL_BEFORE[i] ?? stage.hpMul, xpMul: XP_MUL_BEFORE[i] ?? stage.xpMul })),
    endlessCurve: { ...base.endlessCurve, hpGrowth: HP_GROWTH_BEFORE },
    levelCurve: { ...base.levelCurve, late: { ...late, growth: LATE_GROWTH_BEFORE } },
  };
}
