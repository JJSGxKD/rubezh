import type { Clock } from "./clock.js";

/**
 * Кеш горячих курсов — порт (в бэкенде Redis). Здесь нет ничего, что нельзя
 * восстановить из хранилища: потеря кеша — лишний запрос к базе, не ошибка.
 */
export interface RateCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryRateCache implements RateCache {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly clock: Clock) {}

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.clock.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: this.clock.now() + ttlMs });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}
