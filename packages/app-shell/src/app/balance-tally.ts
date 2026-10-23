import { COUNT_UP_MS } from "../screens/count-up-rules";

/**
 * Счёт баланса в шапке (design/art/direction-v2.md §7.6): награда пришла —
 * число в шапке не меняется сразу, а набегает с тихим счётом монет, и игрок
 * видит, куда легла награда. Числа — та же кривая, что у набегающей награды
 * итогов (`countUpValue`), щелчки — в такт ей.
 */

/**
 * Пауза перед счётом: сначала звучит начисление и разлетаются значки выброса
 * у места награды, потом считает шапка. Без паузы счёт шапки и россыпь
 * начисления звучали бы одним комом.
 */
export const TALLY_DELAY_MS = 450;
/** Больше щелчков на один счёт не бывает: тысяча монет — не тысяча щелчков. */
export const TALLY_MAX_TICKS = 8;
/** Чаще этого щелчки не звучат: на быстром начале они слились бы в треск. */
export const TALLY_MIN_GAP_MS = 45;
/** На сколько выше последний щелчок первого: кошель наполняется. */
const RATE_RISE = 0.4;

export interface TallyTick {
  /** от начала счёта */
  atMs: number;
  /** скорость воспроизведения щелчка — тон */
  rate: number;
}

/**
 * Считать ли. Первая загрузка кошелька — не начисление, а траты и списания
 * число показывает сразу: счёт вниз выглядел бы как утечка.
 */
export function shouldTally(previous: number | null, next: number): boolean {
  return previous !== null && next > previous;
}

/**
 * Щелчки счёта: по одному на монету, пока монет мало, иначе — потолок,
 * разложенный по равным долям суммы. Время доли — обратная кривая
 * торможения числа, поэтому к концу щелчки редеют вместе с ним, а последний
 * звучит ровно на итоге.
 */
export function tallyTicks(from: number, to: number, durationMs = COUNT_UP_MS): TallyTick[] {
  const count = Math.min(Math.floor(to - from), TALLY_MAX_TICKS);
  if (count <= 0) return [];
  const ticks: TallyTick[] = [];
  for (let i = 1; i <= count; i++) {
    const share = i / count;
    // Обратная к выходу с торможением 1 − (1 − t)³ из `countUpValue`.
    const atMs = Math.round((1 - Math.cbrt(1 - share)) * durationMs);
    const tick = { atMs, rate: 1 + RATE_RISE * share };
    const previous = ticks.at(-1);
    if (previous !== undefined && atMs - previous.atMs < TALLY_MIN_GAP_MS) {
      // Последний щелчок важнее соседа: он совпадает с итогом числа.
      if (i === count) ticks[ticks.length - 1] = tick;
      continue;
    }
    ticks.push(tick);
  }
  return ticks;
}
