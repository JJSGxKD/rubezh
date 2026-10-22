import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PASSIVES, WEAPONS } from "@bh/core-game";
import { HEAL_GLYPH, PASSIVE_GLYPHS, WEAPON_GLYPHS } from "../src/screens/game-glyphs";
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
