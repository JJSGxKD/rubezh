import { describe, expect, it } from "vitest";
import { shardColor, shardRarity, shardTone } from "../src/design-system/components/shard-tones";

// Осколок — один значок на всю игру (docs/27-design-system-and-app-shell.md
// §4.4): цвет — редкость, те же тона, что у предмета в арсенале.

describe("тона осколков", () => {
  it("редкость — из ресурса кошелька; не осколок — не редкость", () => {
    expect(shardRarity("shard_common")).toBe("common");
    expect(shardRarity("shard_legendary")).toBe("legendary");
    expect(shardRarity("coins")).toBeNull();
    expect(shardRarity("gems")).toBeNull();
  });

  it("у каждой редкости свой цвет токеном палитры, и значок с подписью красятся одним тоном", () => {
    const rarities = ["common", "uncommon", "rare", "epic", "legendary", "mythic"];
    expect(new Set(rarities.map(shardColor)).size).toBe(rarities.length);
    expect(new Set(rarities.map(shardTone)).size).toBe(rarities.length);
    for (const rarity of rarities) {
      // var(--color-info) ↔ text-info: значок и обводка рядом не разойдутся
      expect(shardColor(rarity).replace("var(--color-", "text-").replace(")", "")).toBe(shardTone(rarity));
    }
  });

  it("незнакомая редкость от сервера новее клиента — нейтральным тоном, а не пустым местом", () => {
    expect(shardColor("astral")).toBe(shardColor("common"));
    expect(shardTone("astral")).toBe(shardTone("common"));
  });
});
