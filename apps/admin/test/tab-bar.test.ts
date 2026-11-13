import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TabBar } from "../src/ui/tab-bar";

// Общий компонент вкладок панели (tasks/T-0410): строка с чертой акцента, значок числа.

const TABS = [
  { id: "a", title: "Первая" },
  { id: "b", title: "Вторая" },
] as const;

function render(props: { counts?: Partial<Record<"a" | "b", number>>; active?: "a" | "b" } = {}): string {
  return renderToStaticMarkup(
    createElement(TabBar, {
      label: "Проверка",
      tabs: TABS,
      active: props.active ?? "b",
      counts: props.counts,
      onSelect: () => undefined,
    }),
  );
}

describe("TabBar", () => {
  it("даёт строку вкладок с подписью для экранного диктора", () => {
    expect(render()).toContain('role="tablist"');
    expect(render()).toContain('aria-label="Проверка"');
  });

  it("отмечает активную вкладку через aria-selected", () => {
    const html = render({ active: "b" });
    expect(html).toMatch(/aria-selected="false"[^>]*>Первая/);
    expect(html).toMatch(/aria-selected="true"[^>]*>Вторая/);
  });

  it("показывает число значком у вкладки", () => {
    const html = render({ counts: { a: 3 } });
    expect(html).toMatch(/>Первая<span[^>]*>3<\/span>/);
  });

  it("не рисует значок при нуле", () => {
    expect(render({ counts: { a: 0 } })).not.toContain("<span");
  });

  it("не рисует значков без counts", () => {
    expect(render()).not.toContain("<span");
  });

  it("сохраняет порядок кнопок как в tabs", () => {
    const html = render();
    expect(html.indexOf("Первая")).toBeLessThan(html.indexOf("Вторая"));
  });
});
