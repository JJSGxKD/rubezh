import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SlotSummary } from "../src/screens/run/SlotSummary";
import { LevelUpOverlay } from "../src/screens/run/overlays";

// Строка слотов над выбором улучшения (design/art/ui-ux.md, U-13): на узкой
// панели фишки и «Характеристики» — одной строкой значками, подписи остаются
// для диктора; на широкой подписи видны. Ширину решает container query
// панели, а не экран: в ландшафте модалка широкая и на телефоне.

const slots = { weapons: [{ id: "spark", level: 2 }], passives: [{ id: "might", level: 1 }] };

describe("строка слотов", () => {
  it("меряет свою ширину, а не экран", () => {
    expect(renderToStaticMarkup(createElement(SlotSummary, slots))).toContain('class="@container');
  });

  it("на узкой панели подпись фишки — только для диктора, счёт виден всегда", () => {
    const html = renderToStaticMarkup(createElement(SlotSummary, slots));
    expect(html).toMatch(/<span class="[^"]*sr-only @sm:not-sr-only[^"]*">Оружие<\/span>/);
    expect(html).toContain("1/3");
  });

  it("фишки не переносятся строкой ниже", () => {
    expect(renderToStaticMarkup(createElement(SlotSummary, slots))).toMatch(/<ul class="[^"]*flex-nowrap/);
  });
});

describe("окно уровня", () => {
  const render = (queued: number): string =>
    renderToStaticMarkup(
      createElement(LevelUpOverlay, { level: 3, offers: [], queued, loadout: slots, onChoose: () => undefined, onStats: () => undefined }),
    );

  it("«Характеристики» — значком в углу окна, а не плашкой в строке слотов", () => {
    const html = render(0);
    expect(html).toMatch(/<button[^>]*aria-label="Характеристики"/);
    const row = html.slice(html.indexOf('aria-label="Занятые слоты"'));
    expect(row.slice(0, row.indexOf("</ul>"))).not.toContain("Характеристики");
  });

  it("очередь выборов на узкой панели — «+2», полностью — для диктора и на широкой", () => {
    const html = render(2);
    expect(html).toMatch(/<span class="@sm:hidden"[^>]*>\+2<\/span>/);
    expect(html).toMatch(/<span class="sr-only @sm:not-sr-only">[^<]*2[^<]*<\/span>/);
  });
});
