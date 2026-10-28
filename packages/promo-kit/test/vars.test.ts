import { describe, expect, it } from "vitest";
import { resolveDoc, usedVars } from "../src/index.js";
import { baseDoc } from "./helpers.js";

describe("подстановка переменных", () => {
  it("«Код: {code}» с кодом — «Код: ЗИМА25»", () => {
    const resolved = resolveDoc(baseDoc(), { code: "ЗИМА25", link: "https://t.me/bot?start=x" });
    const code = resolved.layers.find((layer) => layer.id === "code");
    expect(code).toMatchObject({ type: "text", text: "Код: ЗИМА25" });
  });

  it("{link} и {reward} подставляются во все вхождения", () => {
    const doc = baseDoc();
    const title = doc.layers[0];
    if (title.type !== "text") throw new Error("ожидался текст");
    title.text = "{reward}! {reward} по {link}";
    const resolved = resolveDoc(doc, { reward: "300 монет и 5 самоцветов", link: "https://x.y" });
    expect(resolved.layers[0]).toMatchObject({ text: "300 монет и 5 самоцветов! 300 монет и 5 самоцветов по https://x.y" });
  });

  it("переменной нет в vars — текст пустой, а не «undefined»", () => {
    const resolved = resolveDoc(baseDoc(), {});
    expect(resolved.layers.find((layer) => layer.id === "code")).toMatchObject({ text: "Код: " });
  });

  it("неизвестные скобки остаются как есть", () => {
    const doc = baseDoc();
    const title = doc.layers[0];
    if (title.type !== "text") throw new Error("ожидался текст");
    title.text = "{other} {code}";
    expect(resolveDoc(doc, { code: "А1" }).layers[0]).toMatchObject({ text: "{other} А1" });
  });

  it("нет link — слой qr скрыт; есть link — виден и несёт адрес", () => {
    const without = resolveDoc(baseDoc(), { code: "А1" }).layers.find((layer) => layer.id === "qr");
    expect(without?.hidden).toBe(true);
    const withLink = resolveDoc(baseDoc(), { link: "https://t.me/bot?start=x" }).layers.find((layer) => layer.id === "qr");
    expect(withLink?.hidden).not.toBe(true);
    expect(withLink).toMatchObject({ data: "https://t.me/bot?start=x" });
  });

  it("исходный документ не меняется", () => {
    const doc = baseDoc();
    const before = JSON.stringify(doc);
    resolveDoc(doc, { code: "ЗИМА25", link: "https://x.y" });
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("значения подставляются как текст: «$&» и фигурные скобки в коде не ломают замену", () => {
    const resolved = resolveDoc(baseDoc(), { code: "$&{link}" });
    expect(resolved.layers.find((layer) => layer.id === "code")).toMatchObject({ text: "Код: $&{link}" });
  });
});

describe("какие переменные встречаются", () => {
  it("{code} в двух слоях — один раз", () => {
    const doc = baseDoc();
    const title = doc.layers[0];
    if (title.type !== "text") throw new Error("ожидался текст");
    title.text = "{code}";
    doc.layers = doc.layers.filter((layer) => layer.type !== "qr");
    expect(usedVars(doc)).toEqual(["code"]);
  });

  it("слой qr требует link; порядок фиксирован: code, link, reward", () => {
    const doc = baseDoc();
    const title = doc.layers[0];
    if (title.type !== "text") throw new Error("ожидался текст");
    title.text = "{reward}";
    expect(usedVars(doc)).toEqual(["code", "link", "reward"]);
  });

  it("скрытые слои не считаются", () => {
    const doc = baseDoc();
    for (const layer of doc.layers) layer.hidden = true;
    expect(usedVars(doc)).toEqual([]);
  });
});
