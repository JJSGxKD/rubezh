import { describe, expect, it } from "vitest";
import { sparse, sparseLabel } from "../src/ui/daily-bars";

// График «За N дней» на редком ряде (tasks/T-0358): меньше трёх дней с данными — точки и «мало данных».

const days = (counts: readonly number[]) => counts.map((count, index) => ({ day: `2026-10-${String(index + 1).padStart(2, "0")}`, count }));
const FOURTEEN = (filled: readonly number[]) => days(Array.from({ length: 14 }, (_, index) => (filled.includes(index) ? 5 : 0)));

describe("редкий ряд", () => {
  it("один или два дня с данными — мало", () => {
    expect(sparse(FOURTEEN([13]))).toBe(true);
    expect(sparse(FOURTEEN([3, 13]))).toBe(true);
  });

  it("три дня и больше — столбики, как раньше", () => {
    expect(sparse(FOURTEEN([1, 5, 13]))).toBe(false);
    expect(sparse(FOURTEEN([0, 1, 2, 3, 4]))).toBe(false);
  });

  it("все нули — это «пусто», а не «мало»", () => {
    expect(sparse(FOURTEEN([]))).toBe(false);
    expect(sparse([])).toBe(false);
  });

  it("день без данных не считается, даже если рядом большие значения", () => {
    expect(sparse(days([0, 0, 9, 0, 0, 7, 0]))).toBe(true);
  });
});

describe("подпись «мало данных»", () => {
  it("склоняется: 1 день, 2 дня", () => {
    expect(sparseLabel(1)).toBe("мало данных: 1 день");
    expect(sparseLabel(2)).toBe("мало данных: 2 дня");
  });
});
