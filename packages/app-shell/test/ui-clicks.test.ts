import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { createNoopPlatformUi, type PlatformAdapter } from "@bh/shared-types";
import { Button, IconButton } from "../src/design-system/components/Button";
import { useNavigation } from "../src/state/navigation";
import { initShell } from "../src/state/shell";
import { groupControl, trackClick, trackGroupClick } from "../src/state/ui-clicks";

// Нажатия кнопок дизайн-системы (tasks/T-0226): событие `ui_clicked` с экраном
// и устойчивым именем кнопки. Текста кнопки в событии нет.

let events: { event: string; payload: Record<string, unknown> }[] = [];

beforeEach(() => {
  events = [];
  initShell({
    adapter: { ui: createNoopPlatformUi(), haptic: () => undefined } as unknown as PlatformAdapter,
    capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false },
    storage: undefined,
    analytics: (event, payload) => events.push({ event, payload }),
    build: { version: "test", contentHash: "", platform: "web" },
  });
  useNavigation.setState({ stack: ["shop"] });
});

const clicks = (): { event: string; payload: Record<string, unknown> }[] => events.filter((entry) => entry.event === "ui_clicked");

/** Нажимает первый настоящий `<button>` в дереве, которое вернул компонент без хуков. */
function pressFirstButton(node: ReactNode): void {
  const found = findButton(node);
  if (found === null) throw new Error("в дереве нет <button>");
  (found.props as { onClick: () => void }).onClick();
}

function findButton(node: ReactNode): ReactElement | null {
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
  if (element.type === "button") return element;
  const children = element.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findButton(child as ReactNode);
    if (found !== null) return found;
  }
  return null;
}

describe("нажатие кнопки с track", () => {
  it("Button track=\"buy\" на экране shop → { screen: shop, control: buy }", () => {
    pressFirstButton(Button({ children: "Купить", track: "buy", onClick: () => undefined }));
    expect(clicks()).toEqual([{ event: "ui_clicked", payload: { screen: "shop", control: "buy" } }]);
  });

  it("IconButton тоже шлёт событие и не кладёт в него подпись", () => {
    pressFirstButton(IconButton({ children: "x", label: "Закрыть окно", track: "close", onClick: () => undefined }));
    expect(clicks()).toEqual([{ event: "ui_clicked", payload: { screen: "shop", control: "close" } }]);
    expect(JSON.stringify(events)).not.toContain("Закрыть окно");
  });

  it("выключенная кнопка с track — события нет", () => {
    pressFirstButton(Button({ children: "Купить", track: "buy", disabled: true, onClick: () => undefined }));
    pressFirstButton(IconButton({ children: "x", label: "Закрыть", track: "close", disabled: true }));
    expect(clicks()).toEqual([]);
  });

  it("кнопка без track — события нет, обработчик жив", () => {
    const onClick = vi.fn();
    pressFirstButton(Button({ children: "Купить", onClick }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(clicks()).toEqual([]);
  });
});

describe("группы: вкладки и переключатель", () => {
  it("TabBar track=\"tabs\", пункт friends → control tabs.friends", () => {
    expect(groupControl("tabs", "friends")).toBe("tabs.friends");
    trackGroupClick("tabs", "friends");
    expect(clicks()).toEqual([{ event: "ui_clicked", payload: { screen: "shop", control: "tabs.friends" } }]);
  });

  it("без track у группы события нет", () => {
    trackGroupClick(undefined, "friends");
    expect(clicks()).toEqual([]);
  });
});

describe("формат имени", () => {
  it("пробел, кириллица и верхний регистр — предупреждение, события нет", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const bad of ["buy now", "купить", "Buy", "", "a".repeat(25), "a.b.c"]) trackClick(bad);
    expect(clicks()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(6);
    warn.mockRestore();
  });

  it("точка допустима: «группа.пункт»; до 24 знаков на часть", () => {
    trackClick("tabs.friends");
    trackClick("a".repeat(24));
    expect(clicks().map((entry) => entry.payload.control)).toEqual(["tabs.friends", "a".repeat(24)]);
  });

  it("экран — текущий из навигации, а не из кнопки", () => {
    useNavigation.setState({ stack: ["lobby", "settings"] });
    trackClick("back");
    expect(clicks()[0]?.payload).toEqual({ screen: "settings", control: "back" });
  });
});
