import { describe, expect, it } from "vitest";
import { phoneLayout, type Column } from "../src/ui/kit";

// Таблица на телефоне — карточкой строки (tasks/T-0049): главное поле крупно,
// остальные — парами «название значение», кнопки без заголовка — в углу.

const col = (title: string, extra: Partial<Column<number>> = {}): Column<number> => ({ title, render: (row) => String(row), ...extra });

describe("карточка строки на телефоне", () => {
  it("главная колонка — с признаком primary, иначе первая", () => {
    const columns = [col("Игрок"), col("Забеги", { primary: true }), col("Звёзды")];
    expect(phoneLayout(columns).primary.title).toBe("Забеги");
    expect(phoneLayout([col("Игрок"), col("Забеги")]).primary.title).toBe("Игрок");
  });

  it("пары — остальные колонки в порядке таблицы, без скрытых на телефоне", () => {
    const columns = [col("Игрок"), col("Забеги"), col("Источник", { phone: "hide" }), col("Звёзды", { align: "right" })];
    expect(phoneLayout(columns).pairs.map((column) => column.title)).toEqual(["Забеги", "Звёзды"]);
  });

  it("колонки без заголовка — кнопки: уходят в угол, а не в пары", () => {
    const columns = [col("Игрок"), col("Забеги"), col("")];
    const layout = phoneLayout(columns);
    expect(layout.actions.map((column) => column.title)).toEqual([""]);
    expect(layout.pairs.map((column) => column.title)).toEqual(["Забеги"]);
  });

  it("главная колонка в пары не повторяется, даже если она не первая", () => {
    const columns = [col("Игрок"), col("Забеги", { primary: true })];
    const layout = phoneLayout(columns);
    expect(layout.primary.title).toBe("Забеги");
    expect(layout.pairs.map((column) => column.title)).toEqual(["Игрок"]);
  });

});
