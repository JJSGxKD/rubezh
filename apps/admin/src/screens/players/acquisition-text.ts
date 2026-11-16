/**
 * Откуда пришёл игрок — слова карточки (Р97, T-0072). Чистые функции без React: вид касания и
 * строка метки партнёрки Telegram собираются здесь, а экран только раскладывает их по строкам.
 */

/**
 * Названия видов касания — те же слова, что в списках и воронке (`api/player-list.ts`,
 * `api/funnel.ts`). Вид, которого здесь нет, показывается как пришёл: сервер новее панели.
 */
export const TOUCH_TITLES: Readonly<Record<string, string>> = {
  organic: "Органика",
  click: "Ссылка кампании",
  link: "Прямая ссылка кампании",
  tagged: "Ссылка с метками",
  invite: "Приглашение друга",
  friend: "Ссылка дружбы",
  telegram_affiliate: "Партнёрка Telegram",
  notification: "Кнопка уведомления в боте",
  unknown: "Неизвестно",
};

/** `null` — «—»; известный вид — название, с кодом через «: »; незнакомый — как есть. */
export function touchText(kind: string | null, ref: string | null): string {
  if (kind === null) return "—";
  const title = TOUCH_TITLES[kind] ?? kind;
  return ref === null ? title : `${title}: ${ref}`;
}

/** Строка метки: «код x9Y-z, с 13.10.2026, 14:05» — дату форматирует вызывающий. */
export function affiliateMarkText(ref: string, markedAtText: string): string {
  return `код ${ref}, с ${markedAtText}`;
}
