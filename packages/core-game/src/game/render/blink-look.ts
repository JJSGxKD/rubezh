import { BLINK_APPEAR_SEC, BLINK_FADE_SEC, BLINK_PHASE } from "../patterns/blink";

/**
 * Облик Кикиморы (`patterns/blink.ts`, T-0283): тело тает перед исчезновением, а пока её нет на поле,
 * на земле светится метка — место, где она встанет.
 *
 * Метка — часть чтения боя, как лужи и кольцо осады: без неё урон приходит из ниоткуда, поэтому её не
 * прячет выключатель «Телеграфы» (docs/27-design-system-and-app-shell.md §7.1). Таяние и проявление —
 * состояние самого врага, а не эффект оружия, и выключателю эффектов не подчиняются. Всё здесь — рендер,
 * на исход забега он не влияет.
 */

/** Непрозрачность тела: тает к нулю, скрытой нет, на появлении проявляется; в chase — полная. */
export function blinkAlpha(phase: number, timerSec: number): number {
  switch (phase) {
    case BLINK_PHASE.fading:
      return clamp01(timerSec / BLINK_FADE_SEC);
    case BLINK_PHASE.hidden:
      return 0;
    case BLINK_PHASE.appear:
      return clamp01(1 - timerSec / BLINK_APPEAR_SEC);
    default:
      return 1;
  }
}

/** Сколько метка отсвечена: 0 в момент исчезновения, 1 — когда враг встаёт в её центр. */
export function blinkMarkProgress(timerSec: number, telegraphSec: number): number {
  return telegraphSec > 0 ? clamp01(1 - timerSec / telegraphSec) : 1;
}

/** Радиус кольца метки в начале — во столько тел врага; к концу кольцо сужается до чуть шире тела. */
const MARK_START_MUL = 2.6;
const MARK_END_MUL = 1.15;

/** Радиус кольца метки: сужается от `MARK_START_MUL` до `MARK_END_MUL` радиусов тела. */
export function blinkMarkRadius(bodyRadius: number, progress: number): number {
  const p = clamp01(progress);
  return bodyRadius * (MARK_START_MUL + (MARK_END_MUL - MARK_START_MUL) * p);
}

/** Кадр арта метки: три кадра, кольцо сужается — от широкого (0) к узкому (2). */
export function blinkMarkFrame(progress: number): 0 | 1 | 2 {
  const p = clamp01(progress);
  return p < 1 / 3 ? 0 : p < 2 / 3 ? 1 : 2;
}

/** Имена кадров метки в атласе: у каждого скрывающегося врага свои, по его id. */
export function blinkMarkFrameNames(enemyId: string): string[] {
  return [0, 1, 2].map((k) => `fx/mark_${enemyId}${String(k)}`);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
