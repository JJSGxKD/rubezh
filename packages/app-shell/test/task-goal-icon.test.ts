import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { elementColor } from "../src/screens/element-mark";
import { BOOST_RUN_GLYPH, WEAPON_GLYPHS, XP_CRYSTAL_GLYPH } from "../src/screens/game-glyphs";
import { goalIcon } from "../src/screens/meta/task-row";
import type { TaskItem } from "../src/state/tasks-api";

// Значок цели в «Заданиях» (design/art/direction-v2.md §4.5): задание на
// стихию или оружие — тем же знаком, что в забеге и арсенале, а не общей
// мишенью.

function icon(kind: string, filter: TaskItem["filter"] = null): string {
  return renderToStaticMarkup(goalIcon({ kind, filter }));
}

describe("значок цели задания", () => {
  it("стихия — знаком и цветом стихии", () => {
    const html = icon("element_runs", { element: "fire" });
    expect(html).toContain(`color:${elementColor("fire")}`);
    expect(html).not.toContain("lucide-target");
  });

  it("оружие — его значком из арсенала", () => {
    const html = icon("weapon_runs", { weapon: "spark" });
    const [, firstPath] = WEAPON_GLYPHS.spark?.[0] ?? ["f", ""];
    expect(html).toContain(firstPath);
  });

  it("незнакомая стихия или оружие с сервера — общая мишень, строка не ломается", () => {
    expect(icon("element_runs", { element: "physical" })).toContain("lucide-target");
    expect(icon("element_runs", { element: "void" })).toContain("lucide-target");
    expect(icon("weapon_runs", { weapon: "future_blade" })).toContain("lucide-target");
    expect(icon("element_runs")).toContain("lucide-target");
  });

  it("буст и опыт — своими знаками: зелье и кристалл", () => {
    expect(icon("boost_runs")).toContain(BOOST_RUN_GLYPH[1]?.[1] ?? "нет пути");
    expect(icon("xp_collected")).toContain(XP_CRYSTAL_GLYPH[0]?.[1] ?? "нет пути");
  });

  it("сложность — черепом, прочие виды — как были", () => {
    expect(icon("difficulty_runs", { difficulty: "hard" })).toContain("lucide-skull");
    expect(icon("kills")).toContain("lucide-crosshair");
    expect(icon("unknown_kind")).toContain("lucide-target");
  });
});
