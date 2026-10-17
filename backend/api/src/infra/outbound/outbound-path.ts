/** Сегмент, похожий на ключ: длинный и только из знаков токена. */
const KEY_LIKE = /^[A-Za-z0-9_-]{24,}$/;
/** Токен Bot API в пути: `bot<id>:<секрет>`. */
const BOT_TOKEN = /^bot\d+(?::|%3A)/i;

/**
 * Адрес для записи в журнал без секретов: query отбрасывается целиком, токен
 * бота и сегменты, похожие на ключ (24 знака и больше из `[A-Za-z0-9_-]`),
 * заменяются на звёздочки. Ключи сервисов бывают и в пути
 * (путь вида `/v6/<ключ>/latest/USD`), и в query; в запись не должно попасть ни то,
 * ни другое.
 */
export function safePath(url: string): { host: string; path: string } {
  if (!URL.canParse(url)) return { host: "", path: "" };
  const parsed = new URL(url);
  const path = parsed.pathname
    .split("/")
    .map((segment) => (BOT_TOKEN.test(segment) ? "bot***" : KEY_LIKE.test(segment) ? "***" : segment))
    .join("/");
  return { host: parsed.hostname, path };
}
