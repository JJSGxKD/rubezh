import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BOOSTS, PASSIVES, WEAPONS } from "@bh/core-game";
import { boostIcon } from "../src/screens/boost-icons";
import { BOOST_GLYPHS, GameGlyph, HEAL_GLYPH, PASSIVE_GLYPHS, PLANNED_PASSIVE_GLYPHS, PLANNED_WEAPON_GLYPHS, WEAPON_GLYPHS } from "../src/screens/game-glyphs";
import { ItemIcon } from "../src/screens/item-icons";

// Свои значки оружия и навыков (design/art/direction-v2.md §4.5). Полноту не
// проверяем: новое оружие геймдизайнер добавляет данными, и без своего значка
// оно получает общий, а не роняет тест чужой задачи.

const icon = (kind: "weapon" | "passive" | "heal", id: string): string => renderToStaticMarkup(createElement(ItemIcon, { kind, id, size: 20 }));

describe("значки оружия и навыков", () => {
  it("нет значков для того, чего в контенте нет", () => {
    const weapons = new Set(WEAPONS.map((weapon) => weapon.id));
    const passives = new Set(PASSIVES.map((passive) => passive.id));
    for (const id of Object.keys(WEAPON_GLYPHS)) expect(weapons.has(id), id).toBe(true);
    for (const id of Object.keys(PASSIVE_GLYPHS)) expect(passives.has(id), id).toBe(true);
  });

  it("значки нового контента ждут своего оружия: пришло в контент — переезжают в рабочую карту", () => {
    const weapons = new Set(WEAPONS.map((def) => def.id));
    const passives = new Set(PASSIVES.map((def) => def.id));
    for (const id of Object.keys(PLANNED_WEAPON_GLYPHS)) expect(weapons.has(id), `${id} уже в контенте — перенеси значок в WEAPON_GLYPHS`).toBe(false);
    for (const id of Object.keys(PLANNED_PASSIVE_GLYPHS)) expect(passives.has(id), `${id} уже в контенте — перенеси значок в PASSIVE_GLYPHS`).toBe(false);
  });

  it("значки нового контента рисуются тем же языком", () => {
    for (const glyph of [...Object.values(PLANNED_WEAPON_GLYPHS), ...Object.values(PLANNED_PASSIVE_GLYPHS)]) {
      const html = renderToStaticMarkup(createElement(GameGlyph, { glyph, size: 20 }));
      expect(html).toContain('viewBox="0 0 24 24"');
      expect(html).toContain('stroke="currentColor"');
    }
  });

  it("значок красится цветом плитки и скрыт от скринридера", () => {
    const html = icon("weapon", "spark");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('viewBox="0 0 24 24"');
  });

  it("незнакомое оружие получает общий значок, а не пустое место", () => {
    const html = icon("weapon", "meteor_from_the_future");
    expect(html).toContain("<svg");
    expect(html).not.toBe(icon("weapon", "spark"));
  });

  it("лечение — свой значок", () => {
    expect(HEAL_GLYPH.length).toBeGreaterThan(0);
    expect(icon("heal", "heal")).toContain("fill-opacity");
  });
});

describe("значки бустов", () => {
  const boost = (id: string): string => renderToStaticMarkup(createElement(boostIcon(id), { size: 16 }));

  it("у буста из контента — свой знак, у незнакомого — общий значок", () => {
    for (const def of BOOSTS) {
      if (BOOST_GLYPHS[def.id] === undefined) continue;
      expect(boost(def.id), def.id).not.toContain("lucide");
    }
    expect(boost("нет_такого")).toContain("lucide");
  });

  it("нет знаков для бустов, которых нет в контенте", () => {
    const ids = new Set(BOOSTS.map((def) => def.id));
    for (const id of Object.keys(BOOST_GLYPHS)) expect(ids.has(id), id).toBe(true);
  });
});
