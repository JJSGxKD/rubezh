/** Что куда ведёт на странице входа: QR — обычная ссылка, кнопка — диплинк. */
export interface LoginLinks {
  qr: string;
  button: string;
  fallback: string;
}

/**
 * QR кодирует https-ссылку: камеры Android и Google Lens часто показывают
 * `tg://` текстом без кнопки «Открыть». Кнопка ведёт диплинком сразу в
 * приложение, а у старого сервера без диплинка — той же https-ссылкой.
 */
export function loginLinks(bot: { link: string; deepLink?: string | null | undefined }): LoginLinks {
  return { qr: bot.link, button: bot.deepLink ?? bot.link, fallback: bot.link };
}
