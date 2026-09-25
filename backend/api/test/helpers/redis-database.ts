/**
 * Своя база Redis для файла тестов (docs/17-testing-strategy.md §4.2).
 *
 * Адрес в `PLAYTEST_TEST_REDIS_URL` указывает на базу, которую тест
 * плейтеста очищает целиком (`flushdb`). Файлы тестов идут параллельно, и на
 * общей базе очистка сносила бы ключи соседа прямо посреди его прогона. Поэтому
 * каждый файл, которому нужен Redis, берёт соседнюю базу со своим сдвигом:
 * тот же сервер, другое пространство ключей.
 *
 * Пустой адрес — тест пропускается, как и раньше.
 */
export function redisDatabase(source: string, offset: number): string {
  if (source === "") return "";
  try {
    const parsed = new URL(source);
    const index = Number(parsed.pathname.replace("/", ""));
    const base = Number.isInteger(index) && index > 0 ? index : 15;
    parsed.pathname = `/${Math.max(base - offset, 0)}`;
    return parsed.toString();
  } catch {
    // Адрес не разобрался — пусть тест упадёт на подключении, а не молча
    // уедет на чужую базу.
    return source;
  }
}
