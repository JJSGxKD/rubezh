import { describe, expect, it } from "vitest";
import { docProblems } from "../src/index.js";
import { baseDoc } from "./helpers.js";

describe("проверки документа", () => {
  it("хороший документ — без проблем", () => {
    expect(docProblems(baseDoc())).toEqual([]);
  });

  it("QR 120×120 — проблема с id слоя", () => {
    const doc = baseDoc();
    const qr = doc.layers.find((layer) => layer.id === "qr")!;
    qr.width = 120;
    qr.height = 120;
    const problems = docProblems(doc);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("qr");
    expect(problems[0]).toContain("160");
  });

  it("QR ровно 160 — можно", () => {
    const doc = baseDoc();
    const qr = doc.layers.find((layer) => layer.id === "qr")!;
    qr.width = 160;
    qr.height = 160;
    expect(docProblems(doc)).toEqual([]);
  });

  it("слой целиком за холстом — проблема; частично выходящий — нет", () => {
    const doc = baseDoc();
    const title = doc.layers[0];
    title.x = 2000;
    expect(docProblems(doc).some((problem) => problem.includes("title") && problem.includes("за холстом"))).toBe(true);
    title.x = 1000;
    expect(docProblems(doc)).toEqual([]);
    title.x = -2000;
    title.y = -2000;
    expect(docProblems(doc).some((problem) => problem.includes("за холстом"))).toBe(true);
  });

  it("повтор id — проблема", () => {
    const doc = baseDoc();
    doc.layers.push({ ...doc.layers[0] });
    const problems = docProblems(doc);
    expect(problems.some((problem) => problem.includes("title") && problem.includes("повтор"))).toBe(true);
  });

  it("текст мельче 24 на сторис — проблема; на других форматах — нет", () => {
    const doc = baseDoc();
    const title = doc.layers[0];
    if (title.type !== "text") throw new Error("ожидался текст");
    title.size = 20;
    expect(docProblems(doc).some((problem) => problem.includes("title") && problem.includes("мелко"))).toBe(true);
    expect(docProblems({ ...doc, format: "wide" }).some((problem) => problem.includes("мелко"))).toBe(false);
  });

  it("скрытые слои не проверяются на размер и положение", () => {
    const doc = baseDoc();
    const qr = doc.layers.find((layer) => layer.id === "qr")!;
    qr.width = 50;
    qr.height = 50;
    qr.hidden = true;
    expect(docProblems(doc)).toEqual([]);
  });
});
