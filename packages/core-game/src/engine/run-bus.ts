import type { RunEvents } from "../run-api";

type Handler<E extends keyof RunEvents> = (payload: RunEvents[E]) => void;

type HandlerSets = { [E in keyof RunEvents]: Set<Handler<E>> };

/**
 * Шина событий забега: движок сообщает, оболочка слушает.
 *
 * Набор слушателей заведён на каждое событие отдельно, а не одной картой с
 * приведением типов: так добавление события в контракт ломает сборку здесь, а
 * не молча превращается в событие, на которое никто не подпишется.
 */
export class RunBus {
  private readonly handlers: HandlerSets = {
    started: new Set(),
    downed: new Set(),
    revived: new Set(),
    hud: new Set(),
    waveReached: new Set(),
    levelUp: new Set(),
    paused: new Set(),
    resumed: new Set(),
    devInfo: new Set(),
    cues: new Set(),
    finished: new Set(),
    abandoned: new Set(),
    diagnostics: new Set(),
    error: new Set(),
  };

  on<E extends keyof RunEvents>(event: E, handler: Handler<E>): () => void {
    const set: Set<Handler<E>> = this.handlers[event];
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /**
   * Ошибка в обработчике оболочки не должна ронять забег: игрок не виноват,
   * что HUD не смог отрисовать число. Сообщение уходит в консоль устройства,
   * с которого потом снимают баг-репорт.
   */
  emit<E extends keyof RunEvents>(event: E, payload: RunEvents[E]): void {
    const set: Set<Handler<E>> = this.handlers[event];
    for (const handler of set) {
      try {
        handler(payload);
      } catch (error: unknown) {
        console.warn(`Обработчик события забега ${event} упал:`, error);
      }
    }
  }

  clear(): void {
    for (const key of Object.keys(this.handlers) as (keyof RunEvents)[]) {
      this.handlers[key].clear();
    }
  }
}
