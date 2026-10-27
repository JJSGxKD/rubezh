import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Modal, ModalHostProvider } from "../src/design-system/components";

// Р119: модалки рисуются в слой в корне приложения, поверх шапки и нижней панели.

describe("слой модалок", () => {
  it("без провайдера окно рисуется на месте", () => {
    const markup = renderToStaticMarkup(createElement(Modal, { title: "Пауза", children: "тело" }));

    expect(markup).toContain('role="dialog"');
  });

  it("слой есть, узла нет — окно ждёт и на месте не рисуется", () => {
    const markup = renderToStaticMarkup(
      createElement(ModalHostProvider, { value: null }, createElement(Modal, { title: "Пауза", children: "тело" })),
    );

    expect(markup).toBe("");
  });

  it("у корня окна есть pointer-events-auto: хост слоя пропускает касания", () => {
    const markup = renderToStaticMarkup(createElement(Modal, { title: "Пауза", children: "тело" }));
    const start = markup.indexOf('role="dialog"');
    const tag = markup.slice(markup.lastIndexOf("<", start), markup.indexOf(">", start) + 1);

    expect(tag).toContain("pointer-events-auto");
  });
});

describe("App: слой модалок", () => {
  const source = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");

  it("слой идёт после нижней панели и главного меню", () => {
    const layer = source.indexOf("data-modal-layer");

    expect(layer).toBeGreaterThan(-1);
    expect(layer).toBeGreaterThan(source.indexOf("<TabBar"));
    expect(layer).toBeGreaterThan(source.indexOf("<MainMenu"));
  });

  it("провайдер слоя оборачивает возвращаемое дерево", () => {
    expect(source).toContain("<ModalHostProvider");
    expect(source.indexOf("<ModalHostProvider")).toBeLessThan(source.indexOf("data-modal-layer"));
    expect(source.indexOf("</ModalHostProvider>")).toBeGreaterThan(source.indexOf("data-modal-layer"));
  });
});
