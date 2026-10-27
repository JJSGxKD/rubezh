import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScreenBoundary } from "../src/app/lazy-screens";

// Ошибка ленивого раздела встаёт на место экрана, мимо `Screen`: отступ от
// прозрачной шапки разделов — у неё самой, иначе заголовок уезжает под шапку.

describe("ошибка загрузки раздела", () => {
  it("отступает от шапки разделов", () => {
    const boundary = new ScreenBoundary({ children: null });
    boundary.state = { failed: true };
    const html = renderToStaticMarkup(boundary.render());
    expect(html).toContain("pt-[var(--app-header-h)]");
    expect(html).toContain("Раздел не загрузился");
  });
});
