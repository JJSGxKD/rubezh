/**
 * Часы — порт: сбор курсов, свежесть и бюджет запросов зависят от времени, а
 * тесты обязаны быть воспроизводимыми. Значение — мс UTC, как `Date.now()`.
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Часы теста: стоят, пока их не подвинут. */
export class FixedClock implements Clock {
  constructor(private current: number) {}

  now(): number {
    return this.current;
  }

  set(ms: number): void {
    this.current = ms;
  }

  advance(ms: number): number {
    this.current += ms;
    return this.current;
  }
}
