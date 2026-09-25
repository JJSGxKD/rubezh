/**
 * Распределённый лок — порт. Опрос источников идёт под локом
 * (docs/15-engineering-standards.md §4.3): со второй реплики незалоченный
 * сбор выполнился бы дважды и дважды потратил бюджет запросов. Функция под
 * локом получает `held()` и обязана уметь прерваться, узнав, что лок потерян.
 */
export type LockOutcome<T> = { acquired: true; result: T } | { acquired: false };

export interface Lock {
  withLock<T>(key: string, ttlMs: number, fn: (held: () => boolean) => Promise<T>): Promise<LockOutcome<T>>;
}

interface Held {
  token: number;
  expiresAt: number;
}

/**
 * Лок в памяти одного процесса — для тестов и запуска без Redis. Срок жизни
 * соблюдается по часам, которые ему передали: лок, у которого вышел TTL,
 * считается потерянным, как и у настоящего.
 */
export class MemoryLock implements Lock {
  private readonly held = new Map<string, Held>();
  private nextToken = 1;

  constructor(private readonly now: () => number) {}

  async withLock<T>(key: string, ttlMs: number, fn: (held: () => boolean) => Promise<T>): Promise<LockOutcome<T>> {
    const current = this.held.get(key);
    if (current && current.expiresAt > this.now()) return { acquired: false };

    const token = this.nextToken++;
    const entry: Held = { token, expiresAt: this.now() + ttlMs };
    this.held.set(key, entry);
    try {
      const result = await fn(() => this.held.get(key)?.token === token && entry.expiresAt > this.now());
      return { acquired: true, result };
    } finally {
      if (this.held.get(key)?.token === token) this.held.delete(key);
    }
  }
}

/** Без лока — для одного процесса, где параллельного сбора быть не может. */
export const noLock: Lock = {
  async withLock(_key, _ttlMs, fn) {
    return { acquired: true, result: await fn(() => true) };
  },
};
