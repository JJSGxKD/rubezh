/** Длина кампании ссылки: слаг режется до неё, она же — потолок названия в кабинете. */
export const CAMPAIGN_SLUG_MAX = 64;

const TRANSLIT: Readonly<Record<string, string>> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/**
 * Название ссылки словами партнёра — в кампанию ссылки: латиница в нижнем регистре, цифры, дефис и
 * подчёркивание, как у ссылок команды (они уходят в разрезы аналитики). Кириллица пишется латиницей, любой
 * другой знак — дефисом. `null` — в названии нет ни буквы, ни цифры.
 */
export function campaignSlug(name: string): string | null {
  const latin = [...name.normalize("NFC").toLowerCase()].map((char) => TRANSLIT[char] ?? char).join("");
  const slug = latin
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, CAMPAIGN_SLUG_MAX)
    .replace(/-+$/, "");
  return /^[a-z0-9]/.test(slug) ? slug : null;
}
