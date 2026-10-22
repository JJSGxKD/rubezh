import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "../src/design-system/components";

// Блик кнопки «Играть» (docs/27 §7.1): при «меньше движения» анимация
// кончается сразу, и полоса не должна застыть на кнопке — вне анимации она
// прозрачна.

function button(props: { shine?: boolean }, children: ReactNode): string {
  return renderToStaticMarkup(createElement(Button, { ...props, cut: true, variant: "primary", onClick: () => undefined, children }));
}

describe("блик кнопки", () => {
  it("полоса прозрачна вне анимации", () => {
    const html = button({ shine: true }, "Играть");
    const strip = /class="([^"]*animate-btn-shine[^"]*)"/.exec(html)?.[1] ?? "";
    expect(strip.split(" ")).toContain("opacity-0");
  });

  it("без shine полосы нет", () => {
    expect(button({}, "Играть")).not.toContain("animate-btn-shine");
  });
});
