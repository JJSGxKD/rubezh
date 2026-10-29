/** Строка лога воркера: JSON с модулем и событием — в том же виде, что у API. Секретов и снимков в неё не кладут. */
export function logEvent(level: "log" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  console[level](JSON.stringify({ module: "sim-worker", event, ...fields }));
}
