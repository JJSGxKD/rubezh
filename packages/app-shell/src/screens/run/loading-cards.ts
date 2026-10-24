import type { KeyValueStorage } from "@bh/shared-types";
import { readNumber } from "../../state/persisted";

/**
 * Колода экрана загрузки забега (design/art/meta-v2.md §9): советы по игре
 * вперемешку с преданиями мира. Карточка — по очереди от забега к забегу, а
 * не случайная: случайная повторяла бы одну и ту же, а новичок первыми видит
 * основы — двигаться, собирать, уворачиваться.
 *
 * Тексты — `i18n/ru-loading.json`: `run.tip.N` и `run.lore.N`. Новая карточка —
 * строка в словаре и число здесь; что они сходятся, проверяет тест.
 */

/** Сколько советов в словаре. */
export const TIP_COUNT = 19;
/** Сколько преданий в словаре. */
export const LORE_COUNT = 10;
/** Первые советы — основы: колода начинается с них подряд. */
export const BASIC_TIPS = 5;
/** Загрузка затянулась — карточка сменяется следующей через столько. */
export const CARD_ROTATE_MS = 6000;

const CARD_KEY = "bh.loadingCard.v1";
/** Выше этого счётчик считается битым: столько забегов на устройстве не бывает. */
const CARD_LIMIT = 1_000_000;

export interface LoadingCard {
  kind: "tip" | "lore";
  /** номер с единицы, как в ключе словаря */
  n: number;
}

export function cardKey(card: LoadingCard): string {
  return `run.${card.kind}.${String(card.n)}`;
}

/**
 * Колода: основы подряд, дальше предание через совет. Преданий меньше
 * советов, поэтому два предания подряд не встают: мир — приправа к советам.
 */
export function loadingDeck(tips = TIP_COUNT, lore = LORE_COUNT, basics = BASIC_TIPS): LoadingCard[] {
  const deck: LoadingCard[] = [];
  for (let n = 1; n <= Math.min(basics, tips); n++) deck.push({ kind: "tip", n });
  for (let i = 0; basics + i < tips || i < lore; i++) {
    if (i < lore) deck.push({ kind: "lore", n: i + 1 });
    if (basics + i < tips) deck.push({ kind: "tip", n: basics + i + 1 });
  }
  return deck;
}

/**
 * Номер карточки для этого показа; следующий показ получит следующую. Без
 * хранилища — всегда первая: площадка вправе его не дать.
 */
export function takeCardIndex(storage: KeyValueStorage | undefined): number {
  const index = Math.floor(readNumber(storage, CARD_KEY, CARD_LIMIT));
  cardShown(storage, index);
  return index;
}

/** Карточка `index` показана: следующий показ начнётся со следующей. */
export function cardShown(storage: KeyValueStorage | undefined, index: number): void {
  storage?.set(CARD_KEY, String(index + 1));
}

/** Карточка по сквозному номеру: колода идёт по кругу. */
export function cardAt(deck: readonly LoadingCard[], index: number): LoadingCard | undefined {
  return deck.length === 0 ? undefined : deck[index % deck.length];
}
