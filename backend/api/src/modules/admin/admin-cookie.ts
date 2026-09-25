/**
 * Cookie сессии панели (docs/29-admin-panel.md §8): отдельная cookie с
 * коротким сроком, `HttpOnly`, `SameSite=Strict`, путь — только маршруты
 * панели. Разбор и сборка здесь свои: одна cookie не стоит зависимости на
 * плагин, а формат её — три строки спецификации.
 *
 * Токен в cookie — случайные 32 байта; в хранилище лежит только его SHA-256,
 * как у токена продления игрока: слепок Redis не даёт рабочих сессий.
 */

export const ADMIN_SESSION_COOKIE = "rubezh_admin_session";

/** Cookie ходит только в панель: игровые маршруты её не видят и не нуждаются. */
export const ADMIN_COOKIE_PATH = "/api/v1/admin";

/**
 * Защита от подделки запроса поверх `SameSite=Strict`: изменяющий запрос
 * обязан нести этот заголовок. Свой заголовок нельзя выставить из формы или
 * картинки на чужом сайте — только скриптом, а скрипту чужого origin
 * браузер не даст его отправить без разрешения CORS, которого у чужого
 * origin нет.
 */
export const ADMIN_CSRF_HEADER = "x-requested-with";
export const ADMIN_CSRF_VALUE = "rubezh-admin";

export function parseCookies(header: string | string[] | undefined): Map<string, string> {
  const result = new Map<string, string>();
  const text = Array.isArray(header) ? header.join("; ") : header;
  if (text === undefined || text === "") return result;
  for (const part of text.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name !== "" && !result.has(name)) result.set(name, safeDecode(value));
  }
  return result;
}

/** `Secure` снимается только в разработке: там панель открывается по http на localhost. */
export function sessionCookie(token: string, ttlSec: number, secure: boolean): string {
  return cookieOf(token, ttlSec, secure);
}

export function clearedSessionCookie(secure: boolean): string {
  return cookieOf("", 0, secure);
}

function cookieOf(value: string, maxAgeSec: number, secure: boolean): string {
  const attributes = [`${ADMIN_SESSION_COOKIE}=${encodeURIComponent(value)}`, `Max-Age=${maxAgeSec}`, `Path=${ADMIN_COOKIE_PATH}`, "HttpOnly", "SameSite=Strict"];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // Битое кодирование — не наша cookie: значение просто не совпадёт ни с одной сессией.
    return value;
  }
}
