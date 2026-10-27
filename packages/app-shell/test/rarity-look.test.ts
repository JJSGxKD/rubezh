import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RARITIES, RarityGlow } from "../src/screens/meta/arsenal-parts";
import { RARITY_SHINE_PERIOD_MS, rarityLook, shineDelayMs } from "../src/screens/meta/rarity-look";

const LAYERS = ["glow", "facets", "shine", "halo", "sparks"] as const;

function layers(rarity: string): number {
  const look = rarityLook(rarity);
  return LAYERS.filter((layer) => look[layer]).length;
}

describe("облик редкости", () => {
  it("каждая следующая редкость не теряет слоёв предыдущей", () => {
    for (let i = 1; i < RARITIES.length; i++) {
      const before = rarityLook(RARITIES[i - 1] ?? "");
      const after = rarityLook(RARITIES[i] ?? "");
      for (const layer of LAYERS) {
        if (before[layer]) expect(after[layer], `${RARITIES[i] ?? ""}: ${layer}`).toBe(true);
      }
    }
  });

  it("слоёв строго больше с каждой ступенью — ступень видна без подписи", () => {
    for (let i = 1; i < RARITIES.length; i++) {
      expect(layers(RARITIES[i] ?? ""), RARITIES[i]).toBeGreaterThan(layers(RARITIES[i - 1] ?? ""));
    }
  });

  it("у каждой редкости свой тон", () => {
    const tones = RARITIES.map((rarity) => rarityLook(rarity).tone);
    expect(new Set(tones).size).toBe(RARITIES.length);
  });

  it("обычная — без украшений, незнакомая рисуется как обычная", () => {
    expect(layers("common")).toBe(0);
    expect(rarityLook("ancient")).toEqual(rarityLook("common"));
  });

  it("блеск у плиток не вспыхивает строем, но фаза плитки стабильна", () => {
    const delays = Array.from({ length: 20 }, (_, i) => shineDelayMs(`item-${String(i)}`));
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(RARITY_SHINE_PERIOD_MS);
    }
    expect(new Set(delays).size).toBeGreaterThan(15);
    expect(shineDelayMs("item-7")).toBe(shineDelayMs("item-7"));
  });
});

describe("слои редкости на плитке", () => {
  const glow = (rarity: string): string => renderToStaticMarkup(createElement(RarityGlow, { rarity, seed: "it-1" }));

  it("обычная плитка — без слоёв", () => {
    expect(glow("common")).toBe("");
  });

  it("слои под значком и не ловят касание", () => {
    const html = glow("rare");
    expect(html).toContain("-z-1");
    expect(html).toContain("pointer-events-none");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("--rarity-tone:var(--color-info)");
  });

  it("добротная — только свет, без оправы и блеска", () => {
    const html = glow("uncommon");
    expect(html).toContain("rarity-glow");
    expect(html).not.toContain("rarity-facets");
    expect(html).not.toContain("animate-btn-shine");
  });

  it("блеск прозрачен вне анимации: при «меньше движения» не застывает полосой", () => {
    const strip = /class="([^"]*animate-btn-shine[^"]*)"/.exec(glow("epic"))?.[1] ?? "";
    expect(strip.split(" ")).toContain("opacity-0");
  });

  it("мифическая — ореол и две искры", () => {
    const html = glow("mythic");
    expect(html).toContain("rarity-halo");
    expect(html.match(/<svg/g)?.length).toBe(2);
  });
});
