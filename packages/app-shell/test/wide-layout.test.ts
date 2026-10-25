import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SideRail } from "../src/design-system/components/SideRail";
import {
  ASIDE_WIDTH_PX,
  RAIL_WIDTH_PX,
  SIDE_PANEL_WIDTH_PX,
  WIDE_COLUMN_PX,
  WIDE_MEDIA_QUERY,
  WIDE_MIN_WIDTH_PX,
  chromeFor,
  contentColumnClass,
  isWideWidth,
  modalPlacementOn,
  screenColumns,
} from "../src/design-system/components/wide-rules";
import { watchWide, type WideMedia } from "../src/state/wide";

// Раскладка для ПК (tasks/T-0298, docs/27-design-system-and-app-shell.md §5.3):
// с 1024 px боковое меню вместо нижнего, шапка с кошельком, вторая колонка
// экрана, листы — панелями справа. Уже 1024 px всё как на телефоне.

const TOKENS = readFileSync(new URL("../src/design-system/tokens.css", import.meta.url), "utf8");

function tokenPx(name: string): number {
  const match = new RegExp(`${name}:\\s*(\\d+)px`).exec(TOKENS);
  if (match?.[1] === undefined) throw new Error(`в tokens.css нет ${name} в пикселях`);
  return Number(match[1]);
}

describe("класс ширины wide", () => {
  it("начинается ровно с 1024 px: решает ширина окна, а не устройство", () => {
    expect(WIDE_MIN_WIDTH_PX).toBe(1024);
    expect(isWideWidth(1023)).toBe(false);
    expect(isWideWidth(1024)).toBe(true);
    expect(isWideWidth(1440)).toBe(true);
    expect(WIDE_MEDIA_QUERY).toBe("(min-width: 1024px)");
  });

  it("телефоны и планшет в портрете — не wide: 320, 390, 768", () => {
    for (const width of [320, 360, 390, 600, 768, 1000]) expect(isWideWidth(width), String(width)).toBe(false);
  });

  it("ландшафт телефона 667×375 — не wide", () => {
    expect(isWideWidth(667)).toBe(false);
  });
});

describe("колонки экрана", () => {
  it("на wide с aside — две колонки; без aside — одна", () => {
    expect(screenColumns({ wide: true, hasAside: true })).toBe("split");
    expect(screenColumns({ wide: true, hasAside: false })).toBe("single");
  });

  it("уже wide aside идёт под основным содержимым, а не рядом", () => {
    expect(screenColumns({ wide: false, hasAside: true })).toBe("single");
    expect(screenColumns({ wide: false, hasAside: false })).toBe("single");
  });

  it("колонка контента: 480 px на телефоне, до --wide-column на wide", () => {
    expect(contentColumnClass(false)).toContain("max-w-[480px]");
    expect(contentColumnClass(true)).toContain("max-w-(--wide-column)");
    expect(contentColumnClass(true)).not.toContain("480");
  });
});

describe("лист снизу становится панелью справа", () => {
  it("на wide лист снизу — панель сбоку", () => {
    expect(modalPlacementOn("bottom", true)).toBe("side");
  });

  it("уже wide лист остаётся снизу", () => {
    expect(modalPlacementOn("bottom", false)).toBe("bottom");
  });

  it("центральные модалки не меняются ни там, ни там; без варианта — по центру", () => {
    expect(modalPlacementOn("center", true)).toBe("center");
    expect(modalPlacementOn("center", false)).toBe("center");
    expect(modalPlacementOn(undefined, true)).toBe("center");
  });
});

describe("что рисует оболочка вокруг экрана", () => {
  it("телефон: нижняя панель и шапка — только у корня раздела", () => {
    expect(chromeFor({ wide: false, inRun: false, tabRoot: true, depth: 1 })).toEqual({ nav: "tabs", header: "app" });
    expect(chromeFor({ wide: false, inRun: false, tabRoot: true, depth: 2 })).toEqual({ nav: "none", header: "none" });
  });

  it("wide: боковое меню вместо нижнего и шапка с кошельком у корня раздела", () => {
    expect(chromeFor({ wide: true, inRun: false, tabRoot: true, depth: 1 })).toEqual({ nav: "rail", header: "wide" });
  });

  it("wide: меню остаётся и на экране, открытом из раздела, а шапки нет — у экрана своя", () => {
    expect(chromeFor({ wide: true, inRun: false, tabRoot: true, depth: 2 })).toEqual({ nav: "rail", header: "none" });
  });

  it("забег: класс ширины ничего не меняет — ни меню, ни шапки", () => {
    expect(chromeFor({ wide: true, inRun: true, tabRoot: true, depth: 1 })).toEqual({ nav: "none", header: "none" });
    expect(chromeFor({ wide: false, inRun: true, tabRoot: true, depth: 1 })).toEqual({ nav: "none", header: "none" });
  });

  it("экран вне разделов (первый запуск, гейты) — без меню", () => {
    expect(chromeFor({ wide: true, inRun: false, tabRoot: false, depth: 1 })).toEqual({ nav: "none", header: "none" });
  });
});

describe("токены раскладки", () => {
  it("числа правил совпадают с tokens.css: --rail-width, --aside-width, --wide-column", () => {
    expect(tokenPx("--rail-width")).toBe(RAIL_WIDTH_PX);
    expect(tokenPx("--aside-width")).toBe(ASIDE_WIDTH_PX);
    expect(tokenPx("--wide-column")).toBe(WIDE_COLUMN_PX);
    expect(tokenPx("--side-panel-width")).toBe(SIDE_PANEL_WIDTH_PX);
  });

  it("размеры из задачи: меню 232, вторая колонка 380, контент 1120, панель 420", () => {
    expect([RAIL_WIDTH_PX, ASIDE_WIDTH_PX, WIDE_COLUMN_PX, SIDE_PANEL_WIDTH_PX]).toEqual([232, 380, 1120, 420]);
  });

  it("панель въезжает по X и только transform с opacity: анимируется лишь то, что не бьёт по раскладке", () => {
    const keyframes = /@keyframes panel-in\s*\{([\s\S]*?)\n  \}/.exec(TOKENS)?.[1] ?? "";
    expect(keyframes).toContain("translateX");
    const properties = [...keyframes.matchAll(/^\s+([a-z-]+):/gm)].map((match) => match[1]);
    expect(properties.every((name) => name === "opacity" || name === "transform")).toBe(true);
  });
});

describe("слежение за шириной окна", () => {
  function fakeMedia(matches: boolean): WideMedia & { set(next: boolean): void; listeners: number } {
    const listeners = new Set<() => void>();
    const media = {
      matches,
      addEventListener: (_type: "change", listener: () => void) => void listeners.add(listener),
      removeEventListener: (_type: "change", listener: () => void) => void listeners.delete(listener),
      set(next: boolean) {
        media.matches = next;
        for (const listener of [...listeners]) listener();
      },
      get listeners() {
        return listeners.size;
      },
    };
    return media;
  }

  it("сообщает текущее значение сразу и каждую смену класса", () => {
    const media = fakeMedia(false);
    const seen: boolean[] = [];
    watchWide(media, (wide) => seen.push(wide));
    media.set(true);
    media.set(false);
    expect(seen).toEqual([false, true, false]);
  });

  it("не перерисовывает, пока класс не сменился", () => {
    const media = fakeMedia(true);
    const seen: boolean[] = [];
    watchWide(media, (wide) => seen.push(wide));
    media.set(true);
    media.set(true);
    expect(seen).toEqual([true]);
  });

  it("отписывается", () => {
    const media = fakeMedia(true);
    const stop = watchWide(media, () => undefined);
    expect(media.listeners).toBe(1);
    stop();
    expect(media.listeners).toBe(0);
  });
});

describe("боковое меню", () => {
  const items = [
    { id: "lobby", label: "Главная", icon: createElement("i"), badge: undefined },
    { id: "arsenal", label: "Арсенал", icon: createElement("i"), badge: "2" },
    { id: "shop", label: "Магазин", icon: createElement("i") },
  ];
  const player = { name: "Дизайнер", avatarUrl: null, level: 3, xpShare: 0.4 };
  const bottom = [{ id: "settings", label: "Настройки", icon: createElement("i"), onSelect: () => undefined }];
  const html = renderToStaticMarkup(
    createElement(SideRail, { items, activeId: "arsenal", track: "rail", player, bottom, onSelect: () => undefined, onProfile: () => undefined }),
  );

  it("разделы те же, что у нижней панели: подписи видны всегда, активный отмечен", () => {
    for (const label of ["Главная", "Арсенал", "Магазин"]) expect(html).toContain(label);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page"[^>]*>(?:(?!<button).)*Арсенал/);
  });

  it("знак счётчика — только у раздела с числом", () => {
    expect(html).toContain(">2<");
    expect(html.match(/bg-danger/g)).toHaveLength(1);
  });

  it("карточка игрока: имя, уровень и опыт полосой", () => {
    expect(html).toContain("Дизайнер");
    expect(html).toContain("3");
    expect(html).toContain("scaleX(0.4)");
  });

  it("внизу — настройки и помощь отдельным блоком", () => {
    expect(html).toContain("Настройки");
  });

  it("это навигация с именем, ширина — из токена", () => {
    expect(html).toMatch(/<nav[^>]*aria-label=/);
    expect(html).toContain("w-(--rail-width)");
  });
});
