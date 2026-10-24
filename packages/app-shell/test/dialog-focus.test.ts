import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Modal } from "../src/design-system/components";
import { trapIndex } from "../src/design-system/components/dialog-focus";

// Фокус в окне (docs/27 §4.4): при открытии фокус уходит в окно, Tab ходит
// по кругу внутри и не уходит на вкладки и HUD под затемнением, при закрытии
// возвращается туда, где был. Замер до правки: из паузы и итогов Tab уводил
// на панель вкладок и кнопку «Пауза» под окном.

describe("Tab внутри окна", () => {
  it("с самого окна — к первому, назад — к последнему", () => {
    expect(trapIndex(3, -1, false)).toBe(0);
    expect(trapIndex(3, -1, true)).toBe(2);
  });

  it("с последнего — по кругу к первому, с первого назад — к последнему", () => {
    expect(trapIndex(3, 2, false)).toBe(0);
    expect(trapIndex(3, 0, true)).toBe(2);
  });

  it("в середине — обычный порядок браузера", () => {
    expect(trapIndex(3, 1, false)).toBeNull();
    expect(trapIndex(3, 1, true)).toBeNull();
    expect(trapIndex(3, 0, false)).toBeNull();
  });

  it("в окне нечего выбрать — фокус стоит на окне", () => {
    expect(trapIndex(0, -1, false)).toBeNull();
  });
});

describe("окно принимает фокус", () => {
  it("само окно фокусируемо программно, но не клавишей и без кольца на весь экран", () => {
    const html = renderToStaticMarkup(createElement(Modal, { title: "Пауза", children: "x" }));
    expect(html).toMatch(/role="dialog"[^>]*tabindex="-1"|tabindex="-1"[^>]*role="dialog"/);
    expect(html).toContain("focus-visible:outline-none");
  });
});
