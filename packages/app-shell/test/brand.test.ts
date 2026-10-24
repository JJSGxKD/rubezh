import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Emblem, Wordmark } from "../src/design-system/components";
import { BootScreen } from "../src/screens/gates";

// Знак игры v2 (design/art/direction-v2.md §7.1): руна Ж с ромбом и словесный
// знак «РУБЕЖ», где та же руна — последняя буква. Статичная заставка
// index.html повторяет заставку оболочки — иначе на подмене мигнёт фон.

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("знак игры", () => {
  it("словесный знак — картинка с именем игры для скринридера", () => {
    const html = renderToStaticMarkup(createElement(Wordmark, { size: "l" }));
    expect(html).toContain('alt="Рубеж"');
    expect(html).toMatch(/src="[^"]*wordmark\.svg/);
  });

  it("знак-руна — украшение, скринридер его пропускает", () => {
    const html = renderToStaticMarkup(createElement(Emblem, { size: 72 }));
    expect(html).toContain('alt=""');
    expect(html).toMatch(/src="[^"]*rune\.svg/);
  });

  it("на заставке знак не стоит рядом со словесным: руна в них одна и та же", () => {
    const boot = renderToStaticMarkup(createElement(BootScreen, { stage: "fonts", version: "1.0.0" }));
    expect(boot).toContain("wordmark.svg");
    expect(boot).not.toContain("rune.svg");
  });
});

describe("статичная заставка index.html", () => {
  const telegram = read("../../../apps/web-telegram/index.html");
  const tokens = read("../../design-tokens/src/tokens.css");
  const bg = /--color-bg:\s*(#[0-9a-f]{6})/i.exec(tokens)?.[1] ?? "нет токена";

  it("фон заставки — тот же, что фон приложения", () => {
    expect(telegram.toLowerCase()).toContain(`background: ${bg.toLowerCase()}`);
    expect(telegram.toLowerCase()).toContain(`<meta name="theme-color" content="${bg.toLowerCase()}"`);
  });

  it("у площадок одна заставка — отличается только заголовок вкладки", () => {
    const strip = (html: string): string => html.replace(/<title>[^<]*<\/title>/, "");
    expect(strip(read("../../../apps/web-max/index.html"))).toBe(strip(telegram));
    expect(strip(read("../../../apps/web-vk/index.html"))).toBe(strip(telegram));
  });
});
