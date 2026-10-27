import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BootScreen, OutsideScreen } from "../src/screens/gates";

// Живой фон на экранах запуска (design/art/direction-v2.md §4.4): заставка —
// первое, что видит игрок. Статичная заставка index.html фона не знает,
// поэтому он проявляется, а не вспыхивает при подмене.

describe("экраны запуска", () => {
  const boot = renderToStaticMarkup(createElement(BootScreen, { stage: "fonts", version: "1.0.0" }));

  it("за заставкой — живой фон, скрытый от скринридера и касаний", () => {
    const layer = /<div aria-hidden="true" class="([^"]*)">/.exec(boot)?.[1] ?? "";
    expect(layer.split(" ")).toEqual(expect.arrayContaining(["pointer-events-none", "-z-10", "animate-fade-in"]));
    expect(boot).toContain("animate-star-twinkle");
  });

  it("фон проявляется плавно и ниже содержимого экрана", () => {
    expect(boot).toContain("[animation-duration:900ms]");
    expect(boot.indexOf("animate-star-twinkle")).toBeLessThan(boot.indexOf("1.0.0"));
  });

  it("тот же фон у экрана «открыто вне Telegram»", () => {
    expect(renderToStaticMarkup(createElement(OutsideScreen, { botUrl: "" }))).toContain("animate-ember-rise");
  });
});
