import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SecondChance } from "../src/screens/run/SecondChance";

// Сетка способов второго шанса (Р210): колонки не распираются содержимым,
// подпись ролика не переносится.
function markup(): string {
  return renderToStaticMarkup(
    createElement(SecondChance, {
      adPreview: { kind: "ready", pass: false, notice: null },
      gemsPreview: { kind: "ready", offer: { continueNo: 1, priceGems: 10, balance: 78 }, notice: null },
      paidPreview: { kind: "ready", offer: { continueNo: 1, priceStars: 10, chargedStars: 10, testMode: false } as never },
    }),
  );
}

describe("раскладка второго шанса", () => {
  it("сетка — контейнер с равными колонками minmax(0,1fr), без grid-cols-2", () => {
    const html = markup();
    expect(html).toContain("@container");
    expect(html).toContain("minmax(0,1fr)");
    expect(html).not.toContain("grid-cols-2");
  });

  it("подписи ролика — обе, каждая в одну строку", () => {
    const html = markup();
    expect(html).toContain("Продолжить за рекламу");
    expect(html).toContain("За рекламу");
    for (const label of ["Продолжить за рекламу</span>", "За рекламу</span>"]) {
      const at = html.indexOf(label);
      expect(at).toBeGreaterThan(0);
      expect(html.slice(html.lastIndexOf("<span", at), at)).toContain("whitespace-nowrap");
    }
  });
});
