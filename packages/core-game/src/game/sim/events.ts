/**
 * События симуляции, которые нужны рендеру: взрыв, вспышка и т.п.
 *
 * Симуляция не знает, что её рисуют, поэтому не может вызвать эффект сама —
 * она только пишет факт в кольцевой буфер. Рендер читает новые записи по
 * счётчику `written` раз в кадр. Буфер не очищается на каждом шаге: за один
 * кадр может пройти несколько шагов, и очистка потеряла бы события всех, кроме
 * последнего.
 *
 * Память выделяется один раз; при переполнении перезаписываются самые старые
 * события — для визуальных эффектов это допустимая потеря, для логики игры
 * буфер не используется.
 */

export const SIM_EVENT = {
  explosion: 1,
} as const;

export type SimEventKind = (typeof SIM_EVENT)[keyof typeof SIM_EVENT];

export const SIM_EVENT_CAPACITY = 64;

export interface SimEvents {
  kind: Uint8Array;
  x: Float32Array;
  y: Float32Array;
  radius: Float32Array;
  tick: Uint32Array;
  /** сколько событий записано за всё время; индекс записи — остаток от ёмкости */
  written: number;
}

export function createSimEvents(capacity: number = SIM_EVENT_CAPACITY): SimEvents {
  return {
    kind: new Uint8Array(capacity),
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    radius: new Float32Array(capacity),
    tick: new Uint32Array(capacity),
    written: 0,
  };
}

export interface SimEventInput {
  kind: SimEventKind;
  x: number;
  y: number;
  radius: number;
  tick: number;
}

export function pushSimEvent(events: SimEvents, event: SimEventInput): void {
  const slot = events.written % events.kind.length;
  events.kind[slot] = event.kind;
  events.x[slot] = event.x;
  events.y[slot] = event.y;
  events.radius[slot] = event.radius;
  events.tick[slot] = event.tick;
  events.written++;
}
