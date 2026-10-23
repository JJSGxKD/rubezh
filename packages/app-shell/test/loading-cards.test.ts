import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod/mini";
import type { KeyValueStorage } from "@bh/shared-types";
import { BASIC_TIPS, cardKey, cardShown, LORE_COUNT, loadingDeck, takeCardIndex, TIP_COUNT } from "../src/screens/run/loading-cards";

// Колода экрана загрузки забега (design/art/meta-v2.md §9): советы по игре
// вперемешку с преданиями мира, от забега к забегу — следующая карточка.

const dictionary = (file: string): Record<string, string> =>
  z.record(z.string(), z.string()).parse(JSON.parse(readFileSync(fileURLToPath(new URL(`../src/i18n/${file}`, import.meta.url)), "utf8")));

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage {
  const data = new Map(Object.entries(initial));
  return {
    get: (key) => data.get(key) ?? null,
    set: (key, value) => void data.set(key, value),
    remove: (key) => void data.delete(key),
  };
}

describe("колода загрузки", () => {
  const deck = loadingDeck();

  it("начинается с основ: первые забеги учат двигаться и собирать", () => {
    expect(deck.slice(0, BASIC_TIPS)).toEqual(Array.from({ length: BASIC_TIPS }, (_, i) => ({ kind: "tip", n: i + 1 })));
  });

  it("каждый совет и каждое предание — ровно по разу", () => {
    expect(deck).toHaveLength(TIP_COUNT + LORE_COUNT);
    expect(new Set(deck.map(cardKey)).size).toBe(deck.length);
  });

  it("предания не идут подряд: мир — приправа к советам, а не вместо них", () => {
    for (const [i, card] of deck.entries()) {
      if (i > 0 && card.kind === "lore") expect(deck[i - 1]?.kind).toBe("tip");
    }
  });

  it("у каждой карточки есть текст, и в словаре нет карточек вне колоды", () => {
    const texts = dictionary("ru-loading.json");
    for (const card of deck) expect(texts[cardKey(card)], cardKey(card)).toBeTruthy();
    const cards = Object.keys(texts).filter((key) => /^run\.(tip|lore)\.\d+$/.test(key));
    expect(cards.sort()).toEqual(deck.map(cardKey).sort());
  });

  it("советы живут только в словаре загрузки: чанк забега за них не платит", () => {
    expect(Object.keys(dictionary("ru-run.json")).filter((key) => key.startsWith("run.tip."))).toEqual([]);
  });
});

describe("какую карточку показать", () => {
  it("с первого запуска — первую, дальше — по очереди", () => {
    const storage = memoryStorage();
    expect(takeCardIndex(storage)).toBe(0);
    expect(takeCardIndex(storage)).toBe(1);
    expect(takeCardIndex(storage)).toBe(2);
  });

  it("сменилась карточка посреди загрузки — следующий показ начнётся после неё", () => {
    const storage = memoryStorage();
    const first = takeCardIndex(storage);
    cardShown(storage, first + 1);
    expect(takeCardIndex(storage)).toBe(first + 2);
  });

  it("битое значение в хранилище — с начала колоды, а не падение", () => {
    expect(takeCardIndex(memoryStorage({ "bh.loadingCard.v1": "кот" }))).toBe(0);
    expect(takeCardIndex(memoryStorage({ "bh.loadingCard.v1": "-4" }))).toBe(0);
  });

  it("без хранилища — всегда первая: площадка вправе его не дать", () => {
    expect(takeCardIndex(undefined)).toBe(0);
  });
});
