import { formatDuration, formatNumber } from "../../i18n";
import { APPEARANCE_ORDER, type KnownAppearance } from "./appearance-rules";

/**
 * Правила карточки игрока (tasks/T-0248, docs/35-stage4-plan.md Р48): что
 * делает кнопка для каждого отношения, сколько знаков «ещё», четыре числа,
 * витрина и тон сцены. Чистые функции без React: тесты проверяют решения, а не
 * вёрстку. Ключи словаря отдаёт правило, текст подставляет экран.
 *
 * Отношение, редкость и причина отказа приходят строками: сервер новее клиента
 * может завести новое, и карточка нарисует его как обычное, а не упадёт.
 */

/** Откуда открыта карточка — поле `from` события `player_card_opened`. */
export const CARD_FROM = ["rating", "season", "friends", "profile"] as const;

export type CardFrom = (typeof CARD_FROM)[number];

/** Публичный id игрока: двенадцать строчных шестнадцатеричных знаков (T-0247). */
const PUBLIC_ID_PATTERN = /^[0-9a-f]{12}$/;

/** Годится ли строка в путь запроса: чужая строка (`../friends`) до сети не доходит. */
export function isPublicId(value: string): boolean {
  return PUBLIC_ID_PATTERN.test(value);
}

/** Что делает область действия: `button` нажимается, `disabled` выключена, `label` — слова без кнопки. */
export type ActionMode = "button" | "disabled" | "label";

export interface CardAction {
  /** `add` — позвать, `requested` — ждём ответа, `accept` — принять встречную, `friends` — уже друзья */
  id: "add" | "requested" | "accept" | "friends";
  labelKey: string;
  mode: ActionMode;
}

/**
 * Действие карточки по отношению смотрящего к игроку. Своей карточке действий
 * нет; отношения, которого клиент не знает, — тоже: лучше без кнопки, чем с
 * кнопкой, смысл которой клиенту неизвестен.
 */
export function actionFor(relation: string): CardAction | null {
  switch (relation) {
    case "none":
      return { id: "add", labelKey: "playerCard.addFriend", mode: "button" };
    case "outgoing":
      return { id: "requested", labelKey: "playerCard.requested", mode: "disabled" };
    case "incoming":
      return { id: "accept", labelKey: "playerCard.accept", mode: "button" };
    case "friend":
      return { id: "friends", labelKey: "playerCard.friends", mode: "label" };
    default:
      return null;
  }
}

/** Сколько знаков карточка показывает у аватара: столько же отдаёт сервер (`emblems.top`). */
export const EMBLEMS_SHOWN = 5;

/** Сколько знаков не поместилось в показанные: «+N». Ничего лишнего — `null`. */
export function moreEmblems(held: number, shown: number): number | null {
  if (!Number.isFinite(held) || !Number.isFinite(shown)) return null;
  const rest = Math.floor(held) - Math.floor(shown);
  return rest > 0 ? rest : null;
}

/** Прочерк на месте числа, которого нет. */
const NO_VALUE = "—";

/** Что нужно четырём ячейкам: поля ответа сервера, без остального. */
export interface CardNumbers {
  stats: { runs: number; totalKills: number; bestSurvivalSec: number };
  power: number;
  season: { place: number } | null;
}

export interface StatCell {
  id: "best" | "place" | "runs" | "power";
  labelKey: string;
  text: string;
}

/** Число, у которого ноль значит «ещё нет»: прочерк честнее нуля. */
const positive = (value: number, format: (value: number) => string): string => (Number.isFinite(value) && value > 0 ? format(value) : NO_VALUE);

/** Четыре ячейки по порядку из спецификации; чего нет — «—». */
export function statCells(card: CardNumbers): StatCell[] {
  return [
    { id: "best", labelKey: "playerCard.best", text: positive(card.stats.bestSurvivalSec, formatDuration) },
    { id: "place", labelKey: "playerCard.place", text: card.season === null ? NO_VALUE : positive(card.season.place, formatNumber) },
    { id: "runs", labelKey: "playerCard.runs", text: positive(card.stats.runs, formatNumber) },
    { id: "power", labelKey: "playerCard.power", text: positive(card.power, formatNumber) },
  ];
}

/** Сколько любимых достижений в витрине (docs/35-stage4-plan.md Р48). */
export const FAVORITES_SHOWN = 3;

/** Любимые для витрины: не больше трёх, в порядке сервера. */
export function favoritesShown<T>(favorites: readonly T[]): T[] {
  return favorites.slice(0, FAVORITES_SHOWN);
}

/**
 * Редкость облика по его id — тон сцены. Карточка называет игрока облик
 * только id, а редкости обликов в ответе нет: она лежит в каталоге сервера
 * (`appearance-catalog.ts`), и здесь — его зеркало; тест держит порядок равным
 * списку обликов `APPEARANCE_ORDER`.
 */
const APPEARANCE_RARITY: Readonly<Record<KnownAppearance, string>> = {
  keeper: "common",
  frost: "common",
  herbalist: "uncommon",
  gilded: "uncommon",
  vityaz: "rare",
  vedunya: "rare",
  ohotnitsa: "epic",
  skomoroh: "epic",
  knyaz: "legendary",
  navi: "mythic",
};

/** Редкость облика; облик, которого клиент не знает, — обычный. */
export function appearanceRarity(id: string): string {
  const known = APPEARANCE_ORDER.find((candidate) => candidate === id);
  return known === undefined ? "common" : APPEARANCE_RARITY[known];
}

/** Почему карточку не показать: игрока нет, слишком часто или общий отказ запроса. */
export type CardFailureReason = "not_found" | "too_often" | "offline" | "unauthorized" | "no_identity" | "disabled" | "rejected" | "unavailable";

/**
 * Ключ текста отказа. Свои — «не найден», «слишком часто» и общий «не
 * получилось»; про связь и вход — тексты экранов меты (`sync.failure.*`):
 * «проверь связь» тому, кто открыл игру мимо Telegram, не поможет, и там это
 * уже учтено. Тексты про «рейтинг выключен» и «сервер рейтинга» карточке не
 * подходят.
 */
export function failureTextKey(reason: CardFailureReason): string {
  switch (reason) {
    case "not_found":
      return "playerCard.notFound";
    case "too_often":
      return "playerCard.tooOften";
    case "offline":
    case "unauthorized":
    case "no_identity":
      return `sync.failure.${reason}`;
    default:
      return "playerCard.failed";
  }
}

/**
 * Ключ текста, когда заявка в друзья не ушла: ответы сервера по коду. Игрок
 * пропал (404) и слишком частые заявки (429) говорят своё, потолок друзей или
 * заявок — своё, остальное, в том числе заявка самому себе, — общее «не ушла».
 */
export function requestFailureKey(code: string | undefined): string {
  switch (code) {
    case "friend_not_found":
      return "playerCard.notFound";
    case "rate_limited":
      return "playerCard.tooOften";
    case "friend_limit":
      return "playerCard.requestLimit";
    default:
      return "playerCard.requestFailed";
  }
}

/** Что стало с отношением после ответа на заявку: `friends` — встречную приняли или уже друзья, иначе — заявка ждёт ответа. */
export function relationAfterRequest(status: string): "friend" | "outgoing" {
  return status === "friends" ? "friend" : "outgoing";
}
