import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Badge, type BadgeTone } from "../src/design-system/components";

// Плашка тона (docs/27 §4.2): подложка непрозрачная, на лунке. Полупрозрачная
// светлела на поднятой и выбранной карточке, и цветной текст значка падал
// ниже 4,5:1 — «Ты» в рейтинге, «Один раз» в магазине. Числа палитры держит
// `design-tokens/test/contrast.test.ts`.

const TONES: readonly BadgeTone[] = ["accent", "warning", "danger", "info", "weapon", "passive"];

describe("плашка-значок", () => {
  it.each(TONES)("%s — на непрозрачной подложке своего тона", (tone) => {
    const html = renderToStaticMarkup(createElement(Badge, { tone, children: "Ты" }));
    expect(html).toContain("badge-tinted");
    expect(html).toContain(`--badge-tone:var(--color-${tone})`);
    expect(html).not.toMatch(/bg-[a-z]+\/\d+/);
  });

  it("приглушённая — поверхность и серый текст, без тона", () => {
    const html = renderToStaticMarkup(createElement(Badge, { children: "Скоро" }));
    expect(html).toContain("text-text-muted");
    expect(html).not.toContain("badge-tinted");
  });
});
