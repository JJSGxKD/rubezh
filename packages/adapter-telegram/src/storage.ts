import type { KeyValueStorage } from "@bh/shared-types";

/**
 * Хранилище на устройстве поверх `localStorage`
 * (docs/27-design-system-and-app-shell.md §7).
 *
 * Живёт в адаптере, а не в движке и не в оболочке, ровно ради одного: если
 * закрытый тест покажет, что iOS теряет данные сайта, Telegram-адаптер
 * переедет на `DeviceStorage` площадки, не тронув ни строки выше.
 *
 * Каждое обращение — в `try`: `localStorage` бросает в приватном режиме
 * Safari, при запрете сторонних данных в WebView и при переполнении квоты.
 * Потерянный локальный рекорд не стоит упавшего запуска, поэтому ошибка
 * гасится, а не пробрасывается наружу.
 */
export function createDeviceStorage(): KeyValueStorage {
  return {
    get(key: string): string | null {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },

    set(key: string, value: string): void {
      try {
        globalThis.localStorage?.setItem(key, value);
      } catch {
        // Сознательное игнорирование: квота исчерпана или запись запрещена.
        // Обработка — это и есть «значения не будет», см. KeyValueStorage.
      }
    },

    remove(key: string): void {
      try {
        globalThis.localStorage?.removeItem(key);
      } catch {
        // Сознательное игнорирование, см. выше: доступа к хранилищу нет.
      }
    },
  };
}
