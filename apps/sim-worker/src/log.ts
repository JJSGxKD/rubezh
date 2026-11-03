/** Строка лога воркера: JSON с модулем и событием — в том же виде, что у API. Секретов и снимков в неё не кладут. */
export function logEvent(level: "log" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  console[level](JSON.stringify({ module: "sim-worker", event, ...fields }));
}

/** Как часто повторяющийся сбой — обрыв связи с Redis, который клиент переподключает раз в секунду — попадает в лог. */
const THROTTLE_MS = 60_000;
const lastLoggedAt = new Map<string, number>();

/** То же, что `logEvent`, но не чаще раза в минуту на событие: сбой связи не должен заливать лог. */
export function logThrottled(level: "warn" | "error", event: string, fields: Record<string, unknown> = {}, now = Date.now()): void {
  if (now - (lastLoggedAt.get(event) ?? 0) < THROTTLE_MS) return;
  lastLoggedAt.set(event, now);
  logEvent(level, event, fields);
}
