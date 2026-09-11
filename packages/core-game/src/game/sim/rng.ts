// Детерминированный генератор псевдослучайных чисел.
//
// Почему инжектируемый, а не Math.random: от воспроизводимости зависят
// golden-прогоны баланса, разбор баг-репортов по seed'у и возможная серверная
// перепроверка топовых забегов (docs/17-testing-strategy.md §3.0 и §3.5).
// Math.random не даёт ни того, ни другого — и запрещён в симуляции
// (CLAUDE.md, раздел «Границы слоёв»).
//
// mulberry32 выбран из-за 32-битного состояния: оно целиком помещается в
// снапшот забега и переносится между машинами без разночтений, которые дают
// генераторы на double.

export interface Rng {
  /** Следующее целое из [0, 2^32) */
  nextUint32(): number;
  /** Следующее вещественное из [0, 1) */
  nextFloat(): number;
  /** Целое из [minInclusive, maxExclusive) */
  nextInt(minInclusive: number, maxExclusive: number): number;
  /** Вещественное из [min, max) */
  nextRange(min: number, max: number): number;
  /** Состояние для сохранения в снапшоте и восстановления при перепроверке */
  getState(): number;
  setState(state: number): void;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const nextUint32 = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };

  const nextFloat = (): number => nextUint32() / 4294967296;

  return {
    nextUint32,
    nextFloat,
    nextInt: (minInclusive, maxExclusive) =>
      minInclusive + Math.floor(nextFloat() * (maxExclusive - minInclusive)),
    nextRange: (min, max) => min + nextFloat() * (max - min),
    getState: () => state,
    setState: (next) => {
      state = next >>> 0;
    },
  };
}
