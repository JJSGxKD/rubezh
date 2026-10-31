import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GameGlyph } from "../src/screens/game-glyphs";
import { EMBLEM_GLYPHS } from "../src/screens/meta/emblem-glyphs";

// Значки знаков у имени (Р149) — карта от дизайнера (design/art/src/emblem-glyphs.mjs).

describe("значки знаков", () => {
  it("у каждого знака в карте есть значок — заимствованный значок оружия или стихии не потерялся", () => {
    for (const [id, glyph] of Object.entries(EMBLEM_GLYPHS)) {
      expect(glyph, id).toBeDefined();
      expect(glyph?.length, id).toBeGreaterThan(0);
    }
  });

  it("статусные знаки и места в сезоне — все со своим значком", () => {
    for (const id of ["emb_vip", "emb_tester", "emb_supporter", "emb_team", "emb_season_champion", "emb_season_top10", "emb_season_top100"]) {
      expect(EMBLEM_GLYPHS[id], id).toBeDefined();
    }
  });

  it("значок рисуется тем же языком, что значки оружия", () => {
    const glyph = EMBLEM_GLYPHS.emb_vip;
    if (glyph === undefined) throw new Error("нет значка VIP");
    const html = renderToStaticMarkup(createElement(GameGlyph, { glyph, size: 16 }));
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('stroke="currentColor"');
  });
});
