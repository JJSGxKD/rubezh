import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/i18n/run";
import { BANNER_FADE_MS, BANNER_MS, RubezhBannerView, createBannerTimeline, type BannerMemory, type ShownBanner } from "../src/screens/run/RubezhBanner";
import type { RubezhNotice } from "../src/state/run";

// Баннеры рубежа (tasks/T-0124): появляются по сообщению шины, гаснут сами и
// не перерисовывают бой чаще 10 раз в секунду. Баннер — самостоятельный
// компонент: пролог (T-0280) кормит его своим сообщением.

const spawned: RubezhNotice = { kind: "spawned", seq: 1 };
const cleared: RubezhNotice = { kind: "cleared", seq: 2 };

const view = (shown: ShownBanner | null): string => renderToStaticMarkup(createElement(RubezhBannerView, { shown }));

describe("баннер рубежа: разметка", () => {
  it("страж пришёл — одна строка про стража", () => {
    const html = view({ notice: spawned, phase: "in" });
    expect(html).toContain("Страж рубежа пришёл");
    expect(html).not.toContain("Рубеж взят");
  });

  it("рубеж взят — одна строка про победу и продолжение боя", () => {
    const html = view({ notice: cleared, phase: "in" });
    expect(html).toContain("Рубеж взят! Бой продолжается");
    expect(html).not.toContain("Страж рубежа пришёл");
  });

  it("нет сообщения — нет баннера", () => {
    expect(view(null)).toBe("");
  });

  it("баннер не ловит касания и читается как статус, отступы от выреза — через переменные", () => {
    const html = view({ notice: spawned, phase: "in" });
    expect(html).toContain("pointer-events-none");
    expect(html).toContain('role="status"');
    expect(html).toContain("--app-inset-");
  });

  it("гаснет прозрачностью, а не размерами: в фазе «out» класс прозрачности, в фазе «in» его нет", () => {
    expect(view({ notice: spawned, phase: "out" })).toContain("opacity-0");
    expect(view({ notice: spawned, phase: "in" })).not.toContain("opacity-0");
  });

  it("не анимирует ничего, кроме transform и opacity", () => {
    const html = view({ notice: cleared, phase: "in" });
    expect(html).not.toMatch(/transition-(all|\[?(width|height|top|left|margin))/);
  });
});

describe("баннер рубежа: время жизни", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const changes: (ShownBanner | null)[] = [];
    const timeline = createBannerTimeline((shown) => changes.push(shown));
    return { changes, timeline };
  };

  it("появляется сразу по сообщению", () => {
    const { changes, timeline } = setup();
    timeline.show(spawned);
    expect(changes).toEqual([{ notice: spawned, phase: "in" }]);
  });

  it("гаснет сам: сперва уход, потом убирается", () => {
    const { changes, timeline } = setup();
    timeline.show(spawned);
    vi.advanceTimersByTime(BANNER_MS - BANNER_FADE_MS);
    expect(changes.at(-1)).toEqual({ notice: spawned, phase: "out" });
    vi.advanceTimersByTime(BANNER_FADE_MS);
    expect(changes.at(-1)).toBeNull();
    expect(changes).toHaveLength(3);
  });

  it("держится три-четыре секунды", () => {
    expect(BANNER_MS).toBeGreaterThanOrEqual(3000);
    expect(BANNER_MS).toBeLessThanOrEqual(4000);
  });

  it("то же сообщение второй раз ничего не меняет: перерисовки только по смене сообщения", () => {
    const { changes, timeline } = setup();
    timeline.show(spawned);
    timeline.show(spawned);
    timeline.show({ ...spawned });
    expect(changes).toHaveLength(1);
  });

  it("за секунду перерисовок не больше десяти, даже когда сообщения идут подряд", () => {
    const { changes, timeline } = setup();
    for (let seq = 1; seq <= 6; seq += 1) {
      timeline.show({ kind: seq % 2 === 0 ? "cleared" : "spawned", seq });
      vi.advanceTimersByTime(100);
    }
    expect(changes.length).toBeLessThanOrEqual(10);
  });

  it("два сообщения подряд: показано только второе, таймер первого его не гасит", () => {
    const { changes, timeline } = setup();
    timeline.show(spawned);
    vi.advanceTimersByTime(BANNER_MS - 500);
    timeline.show(cleared);
    expect(changes.at(-1)).toEqual({ notice: cleared, phase: "in" });
    // Таймер первого сообщения истёк бы здесь — второе стоять должно.
    vi.advanceTimersByTime(600);
    expect(changes.at(-1)).toEqual({ notice: cleared, phase: "in" });
    vi.advanceTimersByTime(BANNER_MS);
    expect(changes.at(-1)).toBeNull();
    // Разметка второго сообщения не несёт текста первого.
    const second = view({ notice: cleared, phase: "in" });
    expect(second).toContain("Рубеж взят");
    expect(second).not.toContain("Страж рубежа пришёл");
  });

  it("пустое сообщение (новый забег) убирает баннер сразу и снимает таймеры", () => {
    const { changes, timeline } = setup();
    timeline.show(spawned);
    timeline.show(null);
    expect(changes.at(-1)).toBeNull();
    const count = changes.length;
    vi.advanceTimersByTime(BANNER_MS * 2);
    expect(changes).toHaveLength(count);
  });

  it("после снятия то же сообщение с тем же номером можно показать снова", () => {
    const { changes, timeline } = setup();
    timeline.show(spawned);
    timeline.show(null);
    timeline.show(spawned);
    expect(changes.at(-1)).toEqual({ notice: spawned, phase: "in" });
  });

  it("размонтирование и новый баннер с общей памятью: показанное сообщение второй раз не появляется", () => {
    // Смерть в бою со стражем, второй шанс: экран пересобрал баннер, а в сторе
    // осталось прежнее сообщение с прежним номером.
    const memory: BannerMemory = { seq: null };
    const first: ShownBanner[] = [];
    const a = createBannerTimeline((shown) => shown && first.push(shown), memory);
    a.show(spawned);
    expect(first).toHaveLength(1);
    a.dispose();

    const second: (ShownBanner | null)[] = [];
    const b = createBannerTimeline((shown) => second.push(shown), memory);
    b.show(spawned);
    expect(second).toEqual([]);
    vi.advanceTimersByTime(BANNER_MS * 2);
    expect(second).toEqual([]);
  });

  it("с общей памятью новое сообщение после перемонтирования показывается", () => {
    const memory: BannerMemory = { seq: null };
    const a = createBannerTimeline(() => undefined, memory);
    a.show(spawned);
    a.dispose();

    const changes: (ShownBanner | null)[] = [];
    const b = createBannerTimeline((shown) => changes.push(shown), memory);
    b.show(cleared);
    expect(changes[0]).toEqual({ notice: cleared, phase: "in" });
  });

  it("экран боя не размонтирует баннер на смерти и итоге", () => {
    const source = readFileSync(resolve(__dirname, "../src/screens/run/RunScreen.tsx"), "utf8");
    const line = source.split("\n").find((row) => row.includes("<RubezhBanner")) ?? "";
    expect(line).not.toContain("downed");
    expect(line).not.toContain("finished");
  });

  it("dispose снимает таймеры: после ухода с экрана перерисовок нет", () => {
    const { changes, timeline } = setup();
    timeline.show(spawned);
    timeline.dispose();
    const count = changes.length;
    vi.advanceTimersByTime(BANNER_MS * 2);
    expect(changes).toHaveLength(count);
  });
});
