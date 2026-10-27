import { createHash } from "node:crypto";

/**
 * Страница ссылки для превью (docs/24-attribution-and-sharing.md §3.3): OG-теги
 * — заголовок и описание; ссылка без превью в чате конвертит хуже. Тот же
 * HTML — запасной путь человеку, если ссылку на приложение сейчас не собрать.
 */
export const LINK_PAGE = {
  title: "Рубеж",
  description: "Продержись под натиском как можно дольше — прямо в Telegram.",
} as const;

export function linkPage(options: { url: string | null; target: string | null }): string {
  const title = escapeHtml(LINK_PAGE.title);
  const description = escapeHtml(LINK_PAGE.description);
  const og = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    ...(options.url === null ? [] : [`<meta property="og:url" content="${escapeHtml(options.url)}">`]),
  ].join("\n    ");
  const action = options.target === null ? "<p>Ссылка скоро заработает — попробуй через минуту.</p>" : `<p><a href="${escapeHtml(options.target)}">Открыть игру</a></p>`;
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>${title}</title>
    <meta name="description" content="${description}">
    ${og}
  </head>
  <body>
    <h1>${title}</h1>
    <p>${description}</p>
    ${action}
  </body>
</html>
`;
}

export function notFoundPage(): string {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Ссылка не найдена</title></head>
<body><p>Такой ссылки нет — проверь адрес.</p></body></html>
`;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Скрипт страницы-переходника (docs/24-attribution-and-sharing.md §3, Р94):
 * сразу идёт по диплинку, а если через 2,5 с страница всё ещё на виду и фокус
 * не терялся — приложение не открылось, и переход на запасной `https://t.me`.
 * Открылось приложение — окно браузера теряет фокус или скрывается.
 *
 * Скрипт один и постоянный: его хэш стоит в `script-src`, и `'unsafe-inline'`
 * не нужен. Адреса он берёт из `<script type="application/json">` — это
 * данные, политика их не исполняет.
 */
export const OPEN_SCRIPT = `(function () {
  var data = JSON.parse(document.getElementById("target").textContent);
  var left = false;
  window.addEventListener("blur", function () { left = true; });
  document.addEventListener("visibilitychange", function () { if (document.hidden) left = true; });
  window.setTimeout(function () {
    if (!left && !document.hidden) window.location.replace(data.fallback);
  }, 2500);
  window.location.href = data.deep;
})();`;

/** `'sha256-…'` для `script-src`: считается от `OPEN_SCRIPT` при загрузке модуля. */
export const OPEN_SCRIPT_HASH = `'sha256-${createHash("sha256").update(OPEN_SCRIPT, "utf8").digest("base64")}'`;

/** Страница, открывающая Telegram диплинком; без скрипта работают обе кнопки. */
export function openPage(options: { deep: string; fallback: string }): string {
  const title = escapeHtml("Открываем Telegram…");
  // `<` в JSON заменён на \u003c: адрес с «</script>» не закроет тег данных.
  const data = JSON.stringify({ deep: options.deep, fallback: options.fallback }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>${escapeHtml(LINK_PAGE.title)}</title>
  </head>
  <body>
    <h1>${title}</h1>
    <p>Не открылось? Нажми кнопку.</p>
    <p><a href="${escapeHtml(options.deep)}">Открыть в Telegram</a></p>
    <p><a href="${escapeHtml(options.fallback)}">Открыть в браузере</a></p>
    <script id="target" type="application/json">${data}</script>
    <script>${OPEN_SCRIPT}</script>
  </body>
</html>
`;
}
