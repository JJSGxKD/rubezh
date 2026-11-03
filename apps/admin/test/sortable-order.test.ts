import { describe, expect, it } from "vitest";
import { applyOrder, cancelText, dropText, INSTRUCTIONS, moveItem, moveText, pickUpText, sameOrder } from "../src/ui/sortable-order";

// Порядок списка в панели (tasks/T-0167): чистые функции переноса и тексты для
// экранного диктора. Компонент поверх dnd-kit тонкий — всё, что можно
// сломать незаметно, лежит здесь.

describe("перенос элемента", () => {
  it("вперёд и назад: элемент занимает место того, на кого его положили", () => {
    expect(moveItem(["a", "b", "c", "d"], "a", "c")).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(["a", "b", "c", "d"], "d", "b")).toEqual(["a", "d", "b", "c"]);
  });

  it("на себя, неизвестный id и неизвестное место — тот же порядок, но новый массив", () => {
    const ids = ["a", "b", "c"];
    expect(moveItem(ids, "b", "b")).toEqual(ids);
    expect(moveItem(ids, "x", "b")).toEqual(ids);
    expect(moveItem(ids, "b", "x")).toEqual(ids);
    expect(moveItem(ids, "b", "b")).not.toBe(ids);
  });

  it("исходный массив не меняется", () => {
    const ids = ["a", "b", "c"];
    moveItem(ids, "a", "c");
    expect(ids).toEqual(["a", "b", "c"]);
  });
});

describe("сравнение порядков", () => {
  it("равные — да, перестановка — нет, разной длины — нет", () => {
    expect(sameOrder(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameOrder(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameOrder(["a"], ["a", "b"])).toBe(false);
    expect(sameOrder([], [])).toBe(true);
  });
});

describe("порядок элементов по id", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const idOf = (item: { id: string }) => item.id;

  it("идут по ids", () => {
    expect(applyOrder(items, ["c", "a", "d", "b"], idOf).map(idOf)).toEqual(["c", "a", "d", "b"]);
  });

  it("не названные — в конец, в прежнем порядке", () => {
    expect(applyOrder(items, ["c", "a"], idOf).map(idOf)).toEqual(["c", "a", "b", "d"]);
  });

  it("лишний id пропускается", () => {
    expect(applyOrder(items, ["x", "b", "a"], idOf).map(idOf)).toEqual(["b", "a", "c", "d"]);
  });
});

describe("тексты для экранного диктора", () => {
  it("взяли, переместили, положили, отменили — дословно", () => {
    expect(pickUpText("daily_runs", 2, 5)).toBe("Взяли «daily_runs», место 2 из 5.");
    expect(moveText("daily_runs", 3, 5)).toBe("«daily_runs»: место 3 из 5.");
    expect(dropText("daily_runs", 3, 5, true)).toBe("«daily_runs» положили на место 3 из 5.");
    expect(dropText("daily_runs", 2, 5, false)).toBe("«daily_runs» осталось на месте 2 из 5.");
    expect(cancelText("daily_runs", 2, 5)).toBe("Перестановка «daily_runs» отменена, место 2 из 5.");
  });

  it("инструкция называет пробел, Enter, стрелки и Escape", () => {
    expect(INSTRUCTIONS).toBe("Чтобы переставить, нажмите пробел или Enter. Стрелки двигают элемент, пробел или Enter кладёт на место, Escape отменяет.");
    for (const word of ["пробел", "Enter", "Стрелки", "Escape"]) expect(INSTRUCTIONS).toContain(word);
  });
});
