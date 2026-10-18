import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, Card, CutFrame, Modal } from "../src/design-system/components";

// Срезанный угол с рамкой по срезу (tasks/T-0013, design/README.md): два слоя
// одного многоугольника. Включается свойством `cut`; без него разметка прежняя.

/** `createElement` с обязательным `children` в свойствах: пропсы и вложенное — раздельно, как в разметке. */
function h<P extends { children: ReactNode }>(component: (props: P) => ReactNode, props: Omit<P, "children">, children: ReactNode = null) {
  return createElement(component, { ...props, children } as P);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CutFrame", () => {
  it("внешний слой — срез и рамка тона, размер среза — токеном; первый ребёнок — заливка", () => {
    const html = renderToStaticMarkup(h(CutFrame, { tone: "card", size: "md" }, createElement("b", null, "внутри")));

    expect(html.startsWith('<div class="cut-frame cut-card')).toBe(true);
    expect(html).toContain("--cut:var(--cut-md)");
    expect(html).toContain('<span aria-hidden="true" class="cut-fill');
    expect(html.indexOf("cut-fill")).toBeLessThan(html.indexOf("внутри"));
  });

  it("у кнопки срез меньше — токен --cut-sm", () => {
    const html = renderToStaticMarkup(h(CutFrame, { tone: "primary", size: "sm" }, "Играть"));

    expect(html).toContain("--cut:var(--cut-sm)");
    expect(html).toContain("cut-primary");
  });

  it("класс из свойства добавляется к внешнему слою", () => {
    const html = renderToStaticMarkup(h(CutFrame, { tone: "panel", size: "md", className: "p-5" }, "x"));

    expect(html).toMatch(/class="cut-frame cut-panel[^"]* p-5"/);
  });
});

describe("Card", () => {
  it("с cut — срез вместо поверхности и скругления", () => {
    const html = renderToStaticMarkup(h(Card, { cut: true }, "награда"));

    expect(html).toContain("cut-frame");
    expect(html).not.toContain("surface-card");
    expect(html).not.toContain("rounded-lg");
    expect(html).toContain("награда");
  });

  it("без cut — как раньше", () => {
    const html = renderToStaticMarkup(h(Card, {}, "награда"));

    expect(html).toContain("surface-card");
    expect(html).toContain("rounded-lg");
    expect(html).not.toContain("cut-frame");
  });

  it("с cut и selected — рамка акцента и галочка на месте", () => {
    const html = renderToStaticMarkup(h(Card, { cut: true, selected: true, onClick: () => undefined }, "награда"));

    expect(html).toContain("cut-card-selected");
    expect(html).not.toContain("surface-card-selected");
    expect(html).toContain("bg-accent");
    expect(html).toContain("<svg");
  });
});

describe("Button", () => {
  it("primary с cut — внутри среза малого размера", () => {
    const html = renderToStaticMarkup(h(Button, { cut: true }, "Играть"));

    expect(html).toContain("cut-frame");
    expect(html).toContain("cut-primary");
    expect(html).toContain("--cut:var(--cut-sm)");
    expect(html).toContain("Играть");
  });

  it("primary без cut — как раньше", () => {
    const html = renderToStaticMarkup(h(Button, {}, "Играть"));

    expect(html).toContain("btn-primary");
    expect(html).not.toContain("cut-frame");
  });

  it("secondary с cut — без среза", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const html = renderToStaticMarkup(h(Button, { variant: "secondary", cut: true }, "Назад"));

    expect(html).not.toContain("cut-frame");
    expect(html).toContain("btn-secondary");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("свечение у кнопки со срезом остаётся соседним слоем позади", () => {
    const html = renderToStaticMarkup(h(Button, { cut: true, glow: true, block: true }, "Играть"));

    expect(html.indexOf("halo-accent")).toBeGreaterThanOrEqual(0);
    expect(html.indexOf("halo-accent")).toBeLessThan(html.indexOf("cut-frame"));
  });
});

describe("Modal", () => {
  it("с cut — панель со срезом тона panel", () => {
    const html = renderToStaticMarkup(h(Modal, { title: "Смерть", cut: true }, "текст"));

    expect(html).toContain("cut-frame");
    expect(html).toContain("cut-panel");
    expect(html).not.toContain("surface-panel");
  });

  it("без cut — как раньше", () => {
    const html = renderToStaticMarkup(h(Modal, { title: "Смерть" }, "текст"));

    expect(html).toContain("surface-panel");
    expect(html).not.toContain("cut-frame");
  });
});
