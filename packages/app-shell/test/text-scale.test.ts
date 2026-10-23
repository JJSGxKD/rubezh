import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Крупный шрифт системы (docs/27 §4.4): Android масштабирует текст WebView
// Telegram, и всё, что задано в rem, растёт вместе с ним. Рамки значков в
// шапке и плитка активной вкладки — в px: значки в них и так в px, а с ростом
// рамок при 150 % на 320 px аватар наезжал на монеты и плитка вкладки
// вылезала за экран. Замер — design/art/meta-v2.md §9, «Доступность».

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

describe("крупный шрифт не распирает рамки", () => {
  it("шапка: аватар, колокольчик, меню, рамка валюты и значки — в px", () => {
    const header = read("../src/app/AppHeader.tsx");
    expect(header).not.toMatch(/\bsize-(5|6|11)\b|\bh-8\b|\bmin-h-11\b/);
    expect(header.match(/size-\[44px\]/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it("вкладки сжимаются до своей доли, плитка активной — в px", () => {
    const layout = read("../src/design-system/components/Layout.tsx");
    expect(layout).toMatch(/min-h-16 min-w-0 flex-1/);
    expect(layout).toMatch(/relative inline-flex size-\[44px\] items-center justify-center rounded-lg/);
  });
});
