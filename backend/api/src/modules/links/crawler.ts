/**
 * Краулеры превью ссылок (docs/24-attribution-and-sharing.md §3.3): мессенджер,
 * получив ссылку, сам запрашивает страницу ради превью. Такой запрос — не
 * клик: иначе одна отправка ссылки в чат порождает фантомный клик, конверсия
 * занижается, а «клики без запусков» ложно сигналят о накрутке.
 *
 * Список — по строке User-Agent: боты превью представляются честно, им
 * незачем прятаться. Пустая строка — тоже не человек с браузером.
 */
const CRAWLERS = [
  /TelegramBot/i,
  /WhatsApp/i,
  /facebookexternalhit|Facebot|meta-externalagent/i,
  /Twitterbot/i,
  /Slackbot|Slack-ImgProxy/i,
  /Discordbot/i,
  /vkShare|VKShare/i,
  /SkypeUriPreview/i,
  /Viber/i,
  /LinkedInBot/i,
  /Embedly/i,
  /Pinterest/i,
  /redditbot/i,
  /Applebot/i,
  /Googlebot|bingbot|YandexBot|YandexMobileBot|DuckDuckBot/i,
  /\bbot\b|crawler|spider|preview/i,
];

export function isCrawler(userAgent: string | null): boolean {
  if (userAgent === null || userAgent.trim() === "") return true;
  return CRAWLERS.some((pattern) => pattern.test(userAgent));
}
