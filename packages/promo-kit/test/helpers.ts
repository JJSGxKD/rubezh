import type { PromoDoc } from "../src/index.js";

/** Документ тестов: сторис, палитра из двух цветов, текст с кодом, QR и значок. Каждый вызов — новый объект. */
export function baseDoc(): PromoDoc {
  return {
    version: 1,
    format: "story",
    background: "#1a1626",
    palette: ["#ffb347", "#ffffff"],
    layers: [
      { id: "title", type: "text", x: 80, y: 200, width: 920, height: 200, text: "Зима близко", font: "russo_one", size: 96, weight: 700, color: "#ffffff", align: "center", lineHeight: 1.1, partner: "none" },
      { id: "code", type: "text", x: 80, y: 600, width: 920, height: 120, text: "Код: {code}", font: "ibm_plex_sans", size: 64, weight: 700, color: "#ffb347", align: "center", lineHeight: 1.1, partner: "text" },
      { id: "qr", type: "qr", x: 340, y: 1200, width: 400, height: 400, fg: "#000000", bg: "#ffffff", partner: "none" },
      { id: "logo", type: "logo", x: 80, y: 80, width: 200, height: 80, variant: "full", partner: "none" },
    ],
  } as PromoDoc;
}
