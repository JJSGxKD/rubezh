import { describe, expect, it } from "vitest";
import { BOOSTS } from "@bh/core-game";
import boosts from "../src/i18n/ru-boosts.json";

// Буст без текста покажет игроку ключ вместо имени: список бустов берётся из
// контента движка, а тексты живут в словаре оболочки (docs/35-stage4-plan.md, Р39).

describe("тексты бустов", () => {
  it("у каждого буста контента есть имя и описание", () => {
    const texts: Record<string, string> = boosts;
    const missing = BOOSTS.flatMap((boost) => [boost.nameKey, boost.descriptionKey]).filter((key) => (texts[key] ?? "") === "");
    expect(missing).toEqual([]);
  });

  it("в словаре нет текстов бустов, которых нет в контенте", () => {
    const known = new Set(BOOSTS.flatMap((boost) => [boost.nameKey, boost.descriptionKey]));
    expect(Object.keys(boosts).filter((key) => !known.has(key))).toEqual([]);
  });
});
