/**
 * Пул узлов: проверка здоровья и выбор. Время приходит аргументом (мс от
 * эпохи): внутри нет часов и случайности, поэтому пул одинаково работает в
 * тесте, в бэкенде и в другом проекте.
 */
export const POOL_DEFAULTS = {
  /** как часто проверять здоровый узел */
  probeIntervalMs: 300_000,
  /** повторная проверка после первых отказов, пока узел ещё не «лежит» */
  retryAfterFailMs: 30_000,
  /** потолок паузы между проверками «лежащего» узла */
  maxBackoffMs: 3_600_000,
  /** сколько отказов подряд превращают узел в «лежащий» */
  downAfterFailures: 2,
  /** вес новой задержки в скользящем среднем */
  latencyAlpha: 0.3,
};

export type PoolOptions = typeof POOL_DEFAULTS;

export interface PoolEntry {
  key: string;
  country: string | null;
  state: "unknown" | "healthy" | "down";
  failures: number;
  latencyMs: number | null;
  lastProbeAt: number | null;
  nextProbeAt: number;
}

export type ProbeResult = { ok: true; latencyMs: number } | { ok: false };

/** Показатель степени паузы ограничен, чтобы `2 ** n` не уходил в бесконечность. */
const MAX_BACKOFF_EXPONENT = 30;

export class NodePool {
  private readonly options: PoolOptions;
  private entries = new Map<string, PoolEntry>();

  constructor(options: Partial<PoolOptions> = {}, restore: readonly PoolEntry[] = []) {
    this.options = { ...POOL_DEFAULTS, ...options };
    for (const entry of restore) this.entries.set(entry.key, { ...entry });
  }

  /** Привести пул к списку узлов подписки: пропавшие забываются, новые ждут первой проверки. */
  sync(nodes: readonly { key: string; country: string | null }[], now: number): void {
    const next = new Map<string, PoolEntry>();
    for (const node of nodes) {
      const known = this.entries.get(node.key);
      next.set(
        node.key,
        known === undefined
          ? { key: node.key, country: node.country, state: "unknown", failures: 0, latencyMs: null, lastProbeAt: null, nextProbeAt: now }
          : { ...known, country: node.country },
      );
    }
    this.entries = next;
  }

  /** Узлы, которым пора на проверку: по возрастанию срока, затем по ключу. */
  due(now: number): string[] {
    return [...this.entries.values()]
      .filter((entry) => entry.nextProbeAt <= now)
      .sort((a, b) => a.nextProbeAt - b.nextProbeAt || compareKeys(a.key, b.key))
      .map((entry) => entry.key);
  }

  record(key: string, result: ProbeResult, now: number): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    const { probeIntervalMs, retryAfterFailMs, maxBackoffMs, downAfterFailures, latencyAlpha } = this.options;

    if (result.ok) {
      entry.state = "healthy";
      entry.failures = 0;
      entry.latencyMs = entry.latencyMs === null ? result.latencyMs : latencyAlpha * result.latencyMs + (1 - latencyAlpha) * entry.latencyMs;
      entry.nextProbeAt = now + probeIntervalMs;
    } else {
      entry.failures += 1;
      if (entry.failures >= downAfterFailures) {
        entry.state = "down";
        const exponent = Math.min(entry.failures - downAfterFailures, MAX_BACKOFF_EXPONENT);
        entry.nextProbeAt = now + Math.min(probeIntervalMs * 2 ** exponent, maxBackoffMs);
      } else {
        entry.nextProbeAt = now + retryAfterFailMs;
      }
    }
    entry.lastProbeAt = now;
  }

  /**
   * Здоровые узлы, быстрые первыми. С `countries` — только узлы этих стран: узел
   * без страны подходит лишь когда фильтра нет.
   */
  pick(query: { countries?: readonly string[]; limit: number }): string[] {
    if (query.limit <= 0) return [];
    const countries = query.countries?.map((country) => country.toUpperCase());
    return [...this.entries.values()]
      .filter((entry) => entry.state === "healthy")
      .filter((entry) => countries === undefined || (entry.country !== null && countries.includes(entry.country.toUpperCase())))
      .sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity) || compareKeys(a.key, b.key))
      .slice(0, query.limit)
      .map((entry) => entry.key);
  }

  /** Копия состояния для хранения: восстанавливается конструктором. */
  snapshot(): PoolEntry[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
