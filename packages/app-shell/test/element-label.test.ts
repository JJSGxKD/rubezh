import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WEAPONS } from "@bh/core-game";
import { ElementLabel, weaponElementOf } from "../src/screens/run/SlotSummary";
import { PlayerStatuses } from "../src/screens/run/PlayerStatuses";

// Стихия оружия на карточке уровня и в полоске состояний
// (design/art/direction-v2.md §4.5): тот же знак, что над врагом в забеге.

describe("стихия оружия", () => {
  it("берётся из контента; физический урон — без метки", () => {
    for (const weapon of WEAPONS) {
      const element = weaponElementOf(weapon.id);
      if (weapon.element === undefined || weapon.element === "physical") expect(element, weapon.id).toBeNull();
      else expect(element, weapon.id).toBe(weapon.element);
    }
    expect(weaponElementOf("нет_такого")).toBeNull();
  });

  it("метка — знак стихии её цветом и подпись", () => {
    const html = renderToStaticMarkup(createElement(ElementLabel, { element: "fire" }));
    expect(html).toContain("Огонь");
    expect(html).toContain("<svg");
    expect(html).toContain("color:#");
  });

  it("полоска состояний — теми же знаками, а не общими значками", () => {
    const html = renderToStaticMarkup(createElement(PlayerStatuses, { statuses: [{ element: "poison", sec: 3, stacks: 2 }] }));
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain("×2");
  });
});
