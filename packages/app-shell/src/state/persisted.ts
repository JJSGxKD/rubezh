import type { KeyValueStorage } from "@bh/shared-types";
import type { z } from "zod/v4-mini";

/**
 * Хранение на устройстве. Данные из хранилища — **граница системы**: их
 * пишет предыдущая версия приложения, их может испортить приватный режим или
 * сам игрок. Поэтому читаются они Zod-схемой, а битое значение сбрасывается к
 * умолчанию, а не роняет запуск (docs/27-design-system-and-app-shell.md §7).
 *
 * Версия — в имени ключа, а не в значении: так старое значение не нужно
 * мигрировать, оно просто перестаёт читаться.
 */
export interface PersistedValue<T> {
  read(): T;
  write(value: T): void;
}

export interface PersistedOptions<T> {
  storage: KeyValueStorage | undefined;
  /** полное имя ключа вместе с версией, например `bh.settings.v1` */
  key: string;
  schema: z.ZodMiniType<T>;
  fallback: T;
  /** сообщить о битом значении — в аналитику уходит `client_error` */
  onBroken?: (key: string, reason: string) => void;
}

export function createPersistedValue<T>(options: PersistedOptions<T>): PersistedValue<T> {
  const { storage, key, schema, fallback, onBroken } = options;

  return {
    read(): T {
      // Хранилища может не быть вовсе: площадка вправе его не дать, и это не
      // повод не запускать игру — просто настройки не переживут закрытие.
      const raw = storage?.get(key) ?? null;
      if (raw === null) return fallback;

      try {
        const parsed = schema.safeParse(JSON.parse(raw));
        if (parsed.success) return parsed.data;
        onBroken?.(key, parsed.error.issues[0]?.message ?? "не подходит под схему");
      } catch (error: unknown) {
        onBroken?.(key, error instanceof Error ? error.message : "не разбирается как JSON");
      }

      storage?.remove(key);
      return fallback;
    },

    write(value: T): void {
      // Реализация порта не бросает: в приватном режиме и при переполнении
      // запись молча пропускается. Потерянная настройка не стоит упавшего
      // приложения.
      storage?.set(key, JSON.stringify(value));
    },
  };
}

/**
 * Одиночное число: локальный рекорд и подобное. Схемы у него нет по решению
 * §7 — версия в имени ключа, проверка на конечность и границы правдоподобия.
 */
export function readNumber(
  storage: KeyValueStorage | undefined,
  key: string,
  limit: number,
): number {
  const raw = storage?.get(key) ?? null;
  if (raw === null) return 0;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > limit) {
    storage?.remove(key);
    return 0;
  }
  return value;
}
