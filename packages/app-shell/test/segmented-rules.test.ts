import { describe, expect, it } from "vitest";
import { edgeFade, edgeFadeMask, segmentFitClass, segmentedLayout } from "../src/design-system/components/segmented-rules";

// Правила переключателя видов (tasks/T-0084, T-0231): лунка или вкладки, затухание краёв и класс размера.
// DOM-тестов у оболочки нет, поэтому это чистые функции.

describe("лунка или вкладки", () => {
  it.each([0, 1, 2, 3])("%i сегментов — прежняя лунка", (count) => {
    expect(segmentedLayout(count)).toBe("row");
  });

  it.each([4, 6])("%i сегментов — вкладки строкой: граница на трёх", (count) => {
    expect(segmentedLayout(count)).toBe("tabs");
  });
});

describe("затухание краёв строки вкладок", () => {
  it("начало строки — затухание только справа", () => {
    expect(edgeFade(0, 300, 500)).toEqual({ left: false, right: true });
  });

  it("середина — с обеих сторон", () => {
    expect(edgeFade(100, 300, 600)).toEqual({ left: true, right: true });
  });

  it("конец строки — только слева", () => {
    expect(edgeFade(200, 300, 500)).toEqual({ left: true, right: false });
  });

  it("всё помещается — затухания нет", () => {
    expect(edgeFade(0, 300, 300)).toEqual({ left: false, right: false });
    expect(edgeFade(0, 320, 300)).toEqual({ left: false, right: false });
  });

  it("дробная прокрутка в пределах пикселя края не считается краем", () => {
    expect(edgeFade(0.4, 300, 500).left).toBe(false);
    expect(edgeFade(199.6, 300, 500).right).toBe(false);
  });

  it("маска: краёв нет — маски нет; иначе 16 px прозрачного с нужной стороны", () => {
    expect(edgeFadeMask({ left: false, right: false })).toBeUndefined();
    expect(edgeFadeMask({ left: false, right: true })).toBe("linear-gradient(to right, black calc(100% - 16px), transparent)");
    expect(edgeFadeMask({ left: true, right: false })).toBe("linear-gradient(to right, transparent, black 16px)");
    expect(edgeFadeMask({ left: true, right: true })).toBe("linear-gradient(to right, transparent, black 16px, black calc(100% - 16px), transparent)");
  });
});

describe("размер сегмента", () => {
  it("обычный не изменился", () => {
    expect(segmentFitClass("m")).toBe("px-2 text-sm");
  });

  it("тесный начинается с обычного и сжимается ступенями по ширине экрана", () => {
    const small = segmentFitClass("s");
    expect(small.startsWith(segmentFitClass("m"))).toBe(true);
    expect(small).toContain("max-[24rem]:text-xs");
    expect(small).toContain("max-[22.5rem]:tracking-tighter");
  });

  it("тесный без произвольных размеров: токены, а не числа от руки", () => {
    expect(segmentFitClass("s")).not.toMatch(/(?:^|[\s:])(?:text|px|py|p|tracking|leading)-\[/);
  });
});
