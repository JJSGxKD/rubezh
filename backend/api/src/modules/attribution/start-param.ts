/**
 * Параметр запуска Mini App (`start_param`) — откуда пришёл игрок
 * (docs/34-stage3-plan.md, WP6; docs/24-attribution-and-sharing.md §5).
 *
 * Параметр читается **только из проверенного `initData`**: в теле запроса
 * его может написать кто угодно (docs/33-telegram-mini-app-pitfalls.md §5.2).
 * Даже проверенный, он лишь говорит, по какой ссылке открыли игру, — ни
 * доступа, ни награды по нему не выдаётся.
 *
 * В параметре — один идентификатор, остальное живёт на сервере: у Mini App
 * параметр запуска ровно один, до 64 знаков из `A-Z a-z 0-9 _ -`
 * (docs/33-telegram-mini-app-pitfalls.md §5.1).
 *
 * - `organic` — параметра нет: открыли из меню бота, истории или поиска;
 * - `click` — `c-<код>`, ссылка через нашу редирект-страницу. Строка клика с
 *   источником и кампанией появится вместе с ней, а код запоминается уже
 *   сейчас: сессии, не записанные сегодня, задним числом не восстановятся;
 * - `invite` — приглашение друга из раздела «Друзья»;
 * - `telegram_affiliate` — `_tgr_<id>`, партнёрская программа Telegram;
 * - `unknown` — всё прочее. Сырая строка сохраняется: её можно разобрать
 *   заново, когда появится новый вид ссылок.
 *
 * Разбор без регулярных цепочек по ключам, как в источнике переноса
 * (`parseStartParamUtil`, docs/13-reuse-from-vpnsibcom.md §6): там формат
 * `r-…_source-…_compaing-…` склеивал в одну строку всё подряд, и половину
 * потом чинил отдельный крон.
 */

export const START_KINDS = ["organic", "click", "invite", "telegram_affiliate", "unknown"] as const;
export type StartKind = (typeof START_KINDS)[number];

export interface StartParam {
  kind: StartKind;
  /** строка как пришла — `null` у органического запуска и у мусора, не годного даже в хранение */
  raw: string | null;
  /** идентификатор внутри: код клика, id партнёра Telegram; `null` — его нет */
  ref: string | null;
}

/** Алфавит и длина, которые допускает Telegram. Иное в подписанных данных — не параметр, а поломка. */
const TELEGRAM_START_PARAM = /^[A-Za-z0-9_-]{1,64}$/;
const CLICK = /^c-([A-Za-z0-9]{6,32})$/;
const TELEGRAM_AFFILIATE = /^_tgr_([A-Za-z0-9_-]{1,59})$/;
/** Приглашение друга — `app-shell/src/screens/meta/friends.tsx`, `INVITE_START_PARAM`. */
const INVITE = "invite";

const ORGANIC: StartParam = { kind: "organic", raw: null, ref: null };

export function parseStartParam(value: string | null | undefined): StartParam {
  if (value === null || value === undefined || value === "") return ORGANIC;
  if (!TELEGRAM_START_PARAM.test(value)) return { kind: "unknown", raw: null, ref: null };

  const click = CLICK.exec(value);
  if (click !== null) return { kind: "click", raw: value, ref: click[1] ?? null };
  const affiliate = TELEGRAM_AFFILIATE.exec(value);
  if (affiliate !== null) return { kind: "telegram_affiliate", raw: value, ref: affiliate[1] ?? null };
  if (value === INVITE) return { kind: "invite", raw: value, ref: null };
  return { kind: "unknown", raw: value, ref: null };
}
