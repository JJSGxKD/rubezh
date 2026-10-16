import { describe, expect, it } from "vitest";
import { qrMatrix, qrPath } from "../src/ui/qr-code";

// QR для входа (tasks/T-0056): матрица модулей одной строкой пути SVG. Рисуется
// без вставки разметки строкой — политика источников панели её не любит.

describe("путь QR", () => {
  it("тёмный модуль — квадрат 1×1, порядок — по строкам", () => {
    expect(
      qrPath([
        [true, false],
        [false, true],
      ]),
    ).toBe("M0 0h1v1h-1zM1 1h1v1h-1z");
  });

  it("пустая матрица — пустой путь", () => {
    expect(qrPath([])).toBe("");
    expect(qrPath([[false, false]])).toBe("");
  });
});

describe("матрица QR", () => {
  it("квадратная, с полем в четыре модуля вокруг: сканер без поля не читает", () => {
    const matrix = qrMatrix("tg://resolve?domain=rubezh_bot&start=panel-AbCdEfGhIjKlMnOpQrStUv");
    expect(matrix.length).toBeGreaterThan(21);
    expect(matrix.every((row) => row.length === matrix.length)).toBe(true);
    // Поле — пустые модули по краю.
    const edge = [matrix[0], matrix[3], matrix.at(-1), matrix.at(-4)];
    for (const row of edge) expect(row?.every((module) => !module)).toBe(true);
    // Внутри есть тёмные модули: матрица не пустая.
    expect(matrix.some((row) => row.some(Boolean))).toBe(true);
  });

  it("одна строка — всегда одна и та же матрица", () => {
    expect(qrMatrix("https://t.me/rubezh_bot?start=panel-x")).toEqual(qrMatrix("https://t.me/rubezh_bot?start=panel-x"));
  });
});
