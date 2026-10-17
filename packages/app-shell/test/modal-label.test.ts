import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Modal } from "../src/design-system/components";

// Имя диалога для диктора: свой `title` или заголовок в содержимом. Окно без
// обоих уходит игроку немым (T-0043).

/** Открывающий тег диалога: по нему видно, какие атрибуты имени у него есть. */
function dialogTag(markup: string): string {
  const start = markup.indexOf('role="dialog"');
  return markup.slice(markup.lastIndexOf("<", start), markup.indexOf(">", start) + 1);
}

describe("имя модального окна", () => {
  it("с labelledBy у диалога есть aria-labelledby и нет aria-label", () => {
    const tag = dialogTag(renderToStaticMarkup(createElement(Modal, { labelledBy: "t", children: "тело" })));

    expect(tag).toContain('aria-labelledby="t"');
    expect(tag).not.toContain("aria-label=");
  });

  it("с title — aria-label, как раньше, и без aria-labelledby", () => {
    const tag = dialogTag(renderToStaticMarkup(createElement(Modal, { title: "Пауза", children: "тело" })));

    expect(tag).toContain('aria-label="Пауза"');
    expect(tag).not.toContain("aria-labelledby");
  });
});
