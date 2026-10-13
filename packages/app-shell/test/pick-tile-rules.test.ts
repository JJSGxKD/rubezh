import { describe, expect, it } from "vitest";
import { hasOutsideOffset, SELECTED_MARK_CLASS } from "../src/screens/pick-tile-rules";

describe("значок выбора плитки", () => {
  it("прежний выносной значок распознаётся как вынос за границу", () => {
    expect(hasOutsideOffset("absolute -top-1.5 -right-1.5 inline-flex size-4")).toBe(true);
  });

  it.each([
    "-top-2",
    "-right-1",
    "-bottom-1",
    "-left-1",
    "-start-1",
    "-end-1",
    "-inset-1",
    "-inset-x-1",
    "-inset-y-1",
    "-translate-x-1/2",
    "-translate-y-1",
  ])("класс %s выносит элемент за границу", (token) => {
    expect(hasOutsideOffset(`absolute ${token}`)).toBe(true);
  });

  it("вариант с префиксом тоже считается выносом", () => {
    expect(hasOutsideOffset("max-[359px]:-right-1")).toBe(true);
    expect(hasOutsideOffset("landscape:-top-1")).toBe(true);
  });

  it("отметка внутри плитки не считается выносом", () => {
    expect(hasOutsideOffset("absolute top-0 right-0")).toBe(false);
    expect(hasOutsideOffset("inset-0 top-1 right-1")).toBe(false);
  });

  it("отрицательные отступы не считаются выносом", () => {
    expect(hasOutsideOffset("-mx-1 -mt-1 px-1")).toBe(false);
  });

  it("пустая строка не выносит", () => {
    expect(hasOutsideOffset("")).toBe(false);
  });

  it("класс отметки выбора лежит внутри плитки", () => {
    expect(hasOutsideOffset(SELECTED_MARK_CLASS)).toBe(false);
    const tokens = SELECTED_MARK_CLASS.split(" ");
    expect(tokens).toEqual(expect.arrayContaining(["absolute", "top-0", "right-0"]));
  });
});
