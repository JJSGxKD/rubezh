import { LINK_CODE } from "../links/link-code.js";
import { networkTailParams } from "../links/link-networks.js";
import { parsePairs } from "./start-param-pairs.js";

/**
 * Параметр запуска Mini App (`start_param`) — откуда пришёл игрок
 * (docs/34-stage3-plan.md, WP6; docs/24-attribution-and-sharing.md §5).
 *
 * Параметр читается **только из проверенного `initData`**: в теле запроса
 * его может написать кто угодно (docs/33-telegram-mini-app-pitfalls.md §5.2).
 * Даже проверенный, он лишь говорит, по какой ссылке открыли игру, — ни
 * доступа, ни награды по нему не выдаётся.
 *
 * У Mini App параметр запуска один, из `A-Z a-z 0-9 _ -`: до 512 знаков у
 * `startapp` и до 64 у `/start` бота (docs/33-telegram-mini-app-pitfalls.md §5.1,
 * Р121). Длина проверяется по каналу — `StartChannel`. В параметре обычно один
 * идентификатор, остальное живёт на сервере; исключение — прямая ссылка сети,
 * где вместе с кодом ссылки едут метки клика (`link`).
 *
 * - `organic` — параметра нет: открыли из меню бота, истории или поиска;
 * - `click` — `c-<код>`, ссылка через нашу редирект-страницу. Строка клика с
 *   источником и кампанией появится вместе с ней, а код запоминается уже
 *   сейчас: сессии, не записанные сегодня, задним числом не восстановятся;
 * - `link` — `l-<код ссылки>`, прямая ссылка кампании без переходника
 *   (docs/35-stage4-plan.md Р95): клика нет, есть только запуск. Касание то
 *   же, что у `click`; код — тот же, что в `/r/<код>`, и проверяется тем же
 *   правилом `LINK_CODE`, второго правила кода нет. После кода может идти хвост
 *   меток рекламной сети `_campaign-55_clickid-…_record-…` (Р121,
 *   `links/link-networks.ts`): разобрался — он в `networkParams`, нет — запуск
 *   всё равно `link` с кодом, атрибуция не теряется;
 * - `invite` — приглашение друга из раздела «Друзья»;
 * - `friend` — `f-<код>`, ссылка дружбы: открыл — стал другом владельца
 *   ссылки (docs/35-stage4-plan.md §3.8). Код — ключ к строке `friend_link`,
 *   а не данные о человеке;
 * - `telegram_affiliate` — `_tgr_<id>`, партнёрская программа Telegram;
 * - `notification` — `n-<вид>`, кнопка под уведомлением в боте
 *   (docs/35-stage4-plan.md WP28): по ней видно, возвращают ли сообщения
 *   бота в игру. Вид — в `ref`;
 * - `tagged` — пары «ключ-значение» `src-tgads_cmp-oct` (Р116,
 *   `start-param-pairs.ts`): сервер сам заводит по ним источник. В `ref` —
 *   канонический набор известных пар, поэтому порядок и регистр пар одну ссылку
 *   на несколько не делят;
 * - `unknown` — всё прочее. Сырая строка сохраняется: её можно разобрать
 *   заново, когда появится новый вид ссылок.
 *
 * Разбор без регулярных цепочек по ключам, как в источнике переноса
 * (`parseStartParamUtil`, docs/13-reuse-from-vpnsibcom.md §6): там формат
 * `r-…_source-…_compaing-…` склеивал в одну строку всё подряд, и половину
 * потом чинил отдельный крон.
 */

export const START_KINDS = ["organic", "click", "invite", "telegram_affiliate", "friend", "notification", "link", "tagged", "unknown"] as const;
export type StartKind = (typeof START_KINDS)[number];

export interface StartParam {
  kind: StartKind;
  /** строка как пришла — `null` у органического запуска и у мусора, не годного даже в хранение */
  raw: string | null;
  /** идентификатор внутри: код клика, id партнёра Telegram; `null` — его нет */
  ref: string | null;
  /**
   * Незнакомые ключи пар по алфавиту, без значений. Поле есть только у параметра, разобранного как
   * пары (`tagged`, а также `unknown`, где известных ключей нет, но пары есть), — у остальных видов
   * его нет вовсе.
   */
  unknownKeys?: string[];
  /**
   * Метки рекламной сети из хвоста прямой ссылки (`link`): ключи профиля сети, значения как пришли.
   * Поле есть только у `link` и только если хвост разобрался — у остальных видов и у `link` без хвоста
   * его нет вовсе.
   */
  networkParams?: Record<string, string>;
}

/**
 * Канал, из которого пришёл параметр: у `startapp` Mini App предел 512 знаков, у `/start` бота — 64
 * (Р121). Подписанные данные запуска приходят из Mini App, обновление бота — из чата.
 */
export type StartChannel = "miniapp" | "bot";
export const START_PARAM_MAX: Readonly<Record<StartChannel, number>> = { miniapp: 512, bot: 64 };

/** Алфавит, который допускает Telegram. Иное в подписанных данных — не параметр, а поломка. */
const TELEGRAM_ALPHABET = /^[A-Za-z0-9_-]+$/;
const CLICK = /^c-([A-Za-z0-9]{6,32})$/;
const TELEGRAM_AFFILIATE = /^_tgr_([A-Za-z0-9_-]{1,59})$/;
/** Ссылка дружбы — код из `modules/friends/friend-code.ts`. */
const FRIEND = /^f-([A-Za-z0-9]{8,32})$/;
/** Кнопка уведомления в боте — `modules/notifications-bot/bot-notify-texts.ts`. */
const NOTIFICATION = /^n-([a-z_]{3,32})$/;
/** Прямая ссылка кампании: префикс, дальше — код ссылки по `LINK_CODE`. */
const DIRECT_LINK_PREFIX = "l-";
/**
 * Прежнее приглашение друга без кода: теперь приглашают ссылкой дружбы `f-<код>`
 * (`app-shell/src/state/friends-api.ts`, `friendInviteUrl`), а разосланные раньше
 * ссылки с `invite` по-прежнему узнаются.
 */
const INVITE = "invite";

const ORGANIC: StartParam = { kind: "organic", raw: null, ref: null };

/**
 * Канал по умолчанию — Mini App: сохранённое значение разбирается повторно (автоисточники), а бот не
 * сохраняет параметр длиннее 64 знаков, Mini App — 512, поэтому повторный разбор даёт тот же вид.
 * Вызовы из бота передают канал явно.
 */
export function parseStartParam(value: string | null | undefined, channel: StartChannel = "miniapp"): StartParam {
  if (value === null || value === undefined || value === "") return ORGANIC;
  if (value.length > START_PARAM_MAX[channel] || !TELEGRAM_ALPHABET.test(value)) return { kind: "unknown", raw: null, ref: null };

  const click = CLICK.exec(value);
  if (click !== null) return { kind: "click", raw: value, ref: click[1] ?? null };
  const affiliate = TELEGRAM_AFFILIATE.exec(value);
  if (affiliate !== null) return { kind: "telegram_affiliate", raw: value, ref: affiliate[1] ?? null };
  const friend = FRIEND.exec(value);
  if (friend !== null) return { kind: "friend", raw: value, ref: friend[1] ?? null };
  const notification = NOTIFICATION.exec(value);
  if (notification !== null) return { kind: "notification", raw: value, ref: notification[1] ?? null };
  if (value.startsWith(DIRECT_LINK_PREFIX)) {
    const body = value.slice(DIRECT_LINK_PREFIX.length);
    // Код ссылки — до первого `_`: в `LINK_CODE` его нет, а дальше идёт хвост меток сети.
    const divider = body.indexOf("_");
    const code = divider === -1 ? body : body.slice(0, divider);
    if (LINK_CODE.test(code)) {
      const networkParams = divider === -1 ? null : networkTailParams(body.slice(divider));
      return networkParams === null ? { kind: "link", raw: value, ref: code } : { kind: "link", raw: value, ref: code, networkParams };
    }
  }
  if (value === INVITE) return { kind: "invite", raw: value, ref: null };
  // Пары — последними: приставки `c-`, `l-`, `f-`, `n-` и `_tgr_` разобраны выше и пар не касаются.
  const pairs = parsePairs(value);
  if (pairs !== null) {
    if (pairs.canonical !== null) return { kind: "tagged", raw: value, ref: pairs.canonical, unknownKeys: pairs.unknownKeys };
    return { kind: "unknown", raw: value, ref: null, unknownKeys: pairs.unknownKeys };
  }
  return { kind: "unknown", raw: value, ref: null };
}
