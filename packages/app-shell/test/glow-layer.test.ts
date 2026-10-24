import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "../src/design-system/components/Button";
import { IconFace } from "../src/screens/home-widgets";

// Свечение — соседний слой позади элемента, а не потомок с отрицательным
// z-index: потомок рисуется над фоном своего родителя, и фон «мигает»
// вместе со свечением. Анимируется по-прежнему только opacity (§3.3).

/** Что лежит внутри первой пары тегов `tag`: в `<button>` свечения быть не должно. */
function innerOf(markup: string, tag: string): string {
  const start = markup.indexOf(`<${tag}`);
  const open = markup.indexOf(">", start) + 1;
  return markup.slice(open, markup.lastIndexOf(`</${tag}>`));
}

describe("свечение кнопки", () => {
  const glowing = renderToStaticMarkup(createElement(Button, { glow: true, children: "Крутить" }));

  it("стоит рядом с кнопкой в обёртке isolate, а не внутри неё", () => {
    expect(glowing.startsWith("<span")).toBe(true);
    expect(glowing.slice(0, glowing.indexOf(">"))).toContain("isolate");
    expect(glowing).toContain("animate-glow");
    expect(glowing.indexOf("animate-glow")).toBeLessThan(glowing.indexOf("<button"));
  });

  it("внутри самой кнопки свечения нет", () => {
    expect(innerOf(glowing, "button")).not.toContain("animate-glow");
  });

  it("повторяет скругление кнопки: у обёртки радиуса нет, `inherit` не сработает", () => {
    const halo = glowing.slice(glowing.indexOf("<span", 1), glowing.indexOf("</span>"));
    expect(halo).not.toContain("rounded-[inherit]");
    expect(halo).toContain("rounded-md");
    const large = renderToStaticMarkup(createElement(Button, { glow: true, size: "l", children: "Играть" }));
    expect(large.slice(large.indexOf("<span", 1), large.indexOf("</span>"))).toContain("rounded-lg");
  });

  it("без свечения разметка прежняя: корень — кнопка, обёртки нет", () => {
    const plain = renderToStaticMarkup(createElement(Button, { children: "Играть" }));
    expect(plain.startsWith("<button")).toBe(true);
    expect(plain).not.toContain("animate-glow");
  });

  it("неактивная кнопка не светится и без обёртки", () => {
    const disabled = renderToStaticMarkup(createElement(Button, { glow: true, disabled: true, children: "Играть" }));
    expect(disabled.startsWith("<button")).toBe(true);
  });

  it("block растягивает обёртку, а кнопка внутри остаётся на всю ширину", () => {
    const block = renderToStaticMarkup(createElement(Button, { glow: true, block: true, children: "Играть" }));
    expect(block.slice(0, block.indexOf(">"))).toContain("w-full");
    expect(block.slice(block.indexOf("<button"), block.indexOf(">", block.indexOf("<button")))).toContain("w-full");
  });
});

describe("свечение значка виджета", () => {
  const face = renderToStaticMarkup(createElement(IconFace, { size: "tile", glow: true, children: "★" }));

  it("лежит рядом с плиткой в обёртке isolate, плитка свечения не содержит", () => {
    expect(face.slice(0, face.indexOf(">"))).toContain("isolate");
    expect(face.indexOf("animate-glow")).toBeLessThan(face.indexOf("widget-face"));
    const tile = face.slice(face.indexOf("widget-face") - 12);
    expect(innerOf(tile, "span")).not.toContain("animate-glow");
  });

  // Круглое пятно за квадратной плиткой читалось грязью на экране, а сквозь
  // полупрозрачную плитку было видно, как оно мигает (design/art/ui-ux.md, U-05).
  it("повторяет форму плитки, а не круг, и не просвечивает сквозь неё", () => {
    const halo = face.slice(face.indexOf("<span", 1), face.indexOf("</span>"));
    expect(halo).not.toContain("rounded-full");
    expect(halo).toContain("rounded-lg");
    const tile = face.slice(face.indexOf("widget-face") - 12, face.indexOf(">", face.indexOf("widget-face")));
    expect(tile).toContain("glow-face-solid");
  });

  it("под переключателем движения, как и раньше", () => {
    expect(face).toContain("widget-motion");
  });

  it("без свечения — только плитка", () => {
    const plain = renderToStaticMarkup(createElement(IconFace, { size: "tile", children: "★" }));
    expect(plain).not.toContain("animate-glow");
    expect(plain.startsWith("<span class=\"widget-face")).toBe(true);
  });
});
