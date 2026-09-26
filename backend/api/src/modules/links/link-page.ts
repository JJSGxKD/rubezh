/**
 * Страница ссылки для превью (docs/24-attribution-and-sharing.md §3.3): OG-теги
 * — заголовок и описание; ссылка без превью в чате конвертит хуже. Тот же
 * HTML — запасной путь человеку, если ссылку на приложение сейчас не собрать.
 */
export const LINK_PAGE = {
  title: "Рубеж",
  description: "Продержись под натиском как можно дольше — прямо в Telegram.",
} as const;

/** Превью шеринга: свой заголовок и картинка результата вместо общих. */
export interface PageOverride {
  title: string;
  description: string;
  imageUrl: string | null;
}

export function linkPage(options: { url: string | null; target: string | null; override?: PageOverride | null }): string {
  const title = escapeHtml(options.override?.title ?? LINK_PAGE.title);
  const description = escapeHtml(options.override?.description ?? LINK_PAGE.description);
  const image = options.override?.imageUrl ?? null;
  const og = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    ...(options.url === null ? [] : [`<meta property="og:url" content="${escapeHtml(options.url)}">`]),
    ...(image === null
      ? []
      : [
          `<meta property="og:image" content="${escapeHtml(image)}">`,
          `<meta property="og:image:width" content="1200">`,
          `<meta property="og:image:height" content="630">`,
          `<meta name="twitter:card" content="summary_large_image">`,
        ]),
  ].join("\n    ");
  const action = options.target === null ? "<p>Ссылка скоро заработает — попробуйте через минуту.</p>" : `<p><a href="${escapeHtml(options.target)}">Открыть игру</a></p>`;
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
<body><p>Такой ссылки нет — проверьте адрес.</p></body></html>
`;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
