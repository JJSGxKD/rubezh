import { describe, expect, it } from "vitest";
import { segmentFitClass, segmentedLayout } from "../src/design-system/components/segmented-rules";

// Правила переключателя видов (tasks/T-0084): строка или сетка и класс размера.
// DOM-тестов у оболочки нет, поэтому это чистые функции.

describe("строка или сетка", () => {
  it.each([0, 1, 3])("%i сегментов — строкой", (count) => {
    expect(segmentedLayout(count)).toBe("row");
  });

  it.each([4, 6])("%i сегментов — сеткой: граница на трёх", (count) => {
    expect(segmentedLayout(count)).toBe("grid");
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
