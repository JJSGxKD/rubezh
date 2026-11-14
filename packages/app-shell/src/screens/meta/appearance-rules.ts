/**
 * Правила экрана «Облик» (tasks/T-0238, docs/35-stage4-plan.md Р150): текст
 * источника, кто видит голову в кружке, колонки сетки, порядок карточек.
 * Чистые функции без React и без словаря: ключи отдаёт правило, текст
 * подставляет экран, а тесты проверяют решения, а не вёрстку.
 *
 * Модуль читает и кружок аватара из первой загрузки, поэтому ничего не
 * импортирует: ни словаря, ни состояния.
 */

/** Десять обликов по порядку каталога сервера (`appearance-catalog.ts`). */
export const APPEARANCE_ORDER = ["keeper", "frost", "herbalist", "gilded", "vityaz", "vedunya", "ohotnitsa", "skomoroh", "knyaz", "navi"] as const;

export type KnownAppearance = (typeof APPEARANCE_ORDER)[number];

/** Облик по умолчанию: его рисуют, когда id пуст или клиенту незнаком. */
export const DEFAULT_APPEARANCE: KnownAppearance = "keeper";

/** Источник облика в ответе сервера: вид строкой — сервер новее клиента может завести новый. */
export interface AppearanceSourceInput {
  kind: string;
  level?: number | undefined;
  maxPlace?: number | undefined;
  achievementId?: string | undefined;
  title?: string | undefined;
}

export interface SourceText {
  key: string;
  params: Record<string, string | number>;
}

/**
 * Строка «откуда взять облик» — ключ словаря и параметры. `null`, когда вид
 * источника клиенту не знаком или у него нет нужного числа: строка тогда не
 * рисуется, а не показывает игроку ключ.
 */
export function sourceText(source: AppearanceSourceInput): SourceText | null {
  switch (source.kind) {
    case "start":
      return { key: "appearance.source.start", params: {} };
    case "level":
      return source.level === undefined ? null : { key: "appearance.source.level", params: { level: source.level } };
    case "weekly_points":
      return { key: "appearance.source.weeklyPoints", params: {} };
    case "achievement":
      return { key: "appearance.source.achievement", params: { title: source.title ?? source.achievementId ?? "" } };
    case "event":
      return { key: "appearance.source.event", params: {} };
    case "vip":
      return { key: "appearance.source.vip", params: {} };
    case "season":
      return source.maxPlace === undefined ? null : { key: "appearance.source.season", params: { place: source.maxPlace } };
    default:
      return null;
  }
}

/**
 * Рисуется ли в кружке голова облика. Три условия сразу: зритель видит арт
 * (облики идут к игрокам вместе с ним, Р143), в строке есть облик (сервер до
 * обликов его не отдаёт) и игрок не выбрал фото из Telegram.
 */
export function showHead(viewerArt: boolean, appearance: string | undefined, avatarPhoto: boolean | undefined): boolean {
  return viewerArt && appearance !== undefined && appearance !== "" && avatarPhoto !== true;
}

/** Ширина, с которой сетка карточек переходит с двух колонок на три. */
export const GRID_THREE_COLUMNS_FROM = 400;

/** Колонок в сетке карточек: по две на телефоне, по три шире. */
export function gridColumns(width: number): 2 | 3 {
  return width < GRID_THREE_COLUMNS_FROM ? 2 : 3;
}

/**
 * Карточки по порядку каталога сервера. Сервер уже отдаёт его так, но порядок —
 * договорённость, а не гарантия схемы; облик, которого клиент не знает, идёт
 * в конце в том порядке, в каком пришёл.
 */
export function sortAppearances<T extends { id: string }>(items: readonly T[]): T[] {
  const rank = (id: string): number => {
    const index = APPEARANCE_ORDER.findIndex((known) => known === id);
    return index === -1 ? APPEARANCE_ORDER.length : index;
  };
  return items
    .map((item, position) => ({ item, position }))
    .sort((a, b) => rank(a.item.id) - rank(b.item.id) || a.position - b.position)
    .map((entry) => entry.item);
}

export type CardState = "worn" | "owned" | "locked";

/** Состояние карточки: надет, можно надеть или закрыт. Закрытый не бывает надетым. */
export function cardState(item: { id: string; held: boolean }, effective: string): CardState {
  if (!item.held) return "locked";
  return item.id === effective ? "worn" : "owned";
}

/** Ключ имени облика в словаре; `null` — облик клиенту незнаком, экран покажет его id. */
export function appearanceNameKey(id: string): string | null {
  return APPEARANCE_ORDER.some((known) => known === id) ? `appearance.${id}.name` : null;
}
