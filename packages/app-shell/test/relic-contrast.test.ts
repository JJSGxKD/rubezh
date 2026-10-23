import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Верх окна-реликвии подсвечен тоном (RelicFrame), и приглушённый серый на
// нём падал ниже 4,5:1 — «Выбери улучшение» 4,47, «Улучшений: 5» у большого
// сундука 3,48 (замер design/art/src/contrast-audit.mjs по витрине). Подпись
// под лентой — основным текстом.

describe("подписи на реликвии", () => {
  it("«Выбери улучшение» — основным текстом", () => {
    const overlays = readFileSync(new URL("../src/screens/run/overlays.tsx", import.meta.url), "utf8");
    expect(overlays).toMatch(/text-sm text-text short:hidden">\{t\("run\.levelUp\.subtitle"\)\}/);
  });

  it("«Улучшений: N» в сундуке — тоже: у большого сундука свет золотой", () => {
    const chest = readFileSync(new URL("../src/screens/run/ChestOverlay.tsx", import.meta.url), "utf8");
    expect(chest).toMatch(/text-sm text-text short:hidden">\{t\("run\.chest\.subtitle"/);
  });
});
