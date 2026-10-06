import { describe, expect, it } from "vitest";
import { Sparkles } from "lucide-react";
import { BOOSTS } from "@bh/core-game";
import boosts from "../src/i18n/ru-boosts.json";
import { boostIcon } from "../src/screens/boost-icons";

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
    // `boost.<id>.*` — тексты бустов; `boosts.*` — тексты экрана выбора и плашек забега.
    expect(Object.keys(boosts).filter((key) => key.startsWith("boost.") && !known.has(key))).toEqual([]);
  });

  it("плашка в забеге находит имя и описание по id: ключи бустов — `boost.<id>.*`", () => {
    // В забеге приходит только id из снимка HUD, контента у плашки нет.
    expect(BOOSTS.filter((boost) => boost.nameKey !== `boost.${boost.id}.name` || boost.descriptionKey !== `boost.${boost.id}.description`)).toEqual([]);
  });

  it("у каждого буста контента свой значок, общий — только у незнакомого", () => {
    expect(BOOSTS.filter((boost) => boostIcon(boost.id) === Sparkles).map((boost) => boost.id)).toEqual([]);
    expect(boostIcon("unknown")).toBe(Sparkles);
  });
});
