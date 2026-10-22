import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, type ButtonVariant } from "../src/design-system/components";

// Выключенная главная кнопка (docs/27 §4.4): нейтральная поверхность, а не
// бледная заливка акцента — та над тёмным фоном становится бурой.

function button(props: { variant?: ButtonVariant; cut?: boolean; disabled?: boolean; loading?: boolean }): string {
  return renderToStaticMarkup(createElement(Button, { ...props, onClick: () => undefined, children: "Пригласить" }));
}

describe("выключенная главная кнопка", () => {
  it("плоская primary — поверхность вместо заливки акцента", () => {
    const html = button({ disabled: true });
    expect(html).toContain("btn-resting");
    expect(html).not.toContain("btn-primary");
  });

  it("кнопка звёзд — тоже", () => {
    const html = button({ variant: "stars", disabled: true });
    expect(html).toContain("btn-resting");
    expect(html).not.toContain("btn-stars");
  });

  it("со срезом — рамка панели, а не акцента", () => {
    const html = button({ cut: true, disabled: true });
    expect(html).toContain("cut-panel");
    expect(html).not.toContain("cut-primary");
  });

  it("на загрузке остаётся в своём цвете: действие уже принято", () => {
    expect(button({ loading: true })).toContain("btn-primary");
    expect(button({ cut: true, loading: true })).toContain("cut-primary");
  });

  it("включённая — как раньше", () => {
    expect(button({})).toContain("btn-primary");
    expect(button({ cut: true })).toContain("cut-primary");
  });

  it("у вторичных вариантов выключенное состояние своё", () => {
    expect(button({ variant: "secondary", disabled: true })).toContain("btn-secondary");
    expect(button({ variant: "danger", disabled: true })).toContain("btn-danger");
  });
});
