import { describe, expect, it } from "vitest";
import { applyPartnerEdits, PartnerEditError } from "../src/index.js";
import { baseDoc } from "./helpers.js";

function fails(run: () => unknown): PartnerEditError {
  try {
    run();
  } catch (error) {
    if (error instanceof PartnerEditError) return error;
    throw error;
  }
  throw new Error("правка должна была отклониться");
}

describe("правки партнёра", () => {
  it("текст слоя с partner: text принят, остальное не тронуто", () => {
    const template = baseDoc();
    const edited = applyPartnerEdits(template, { layers: { code: { text: "Мой код: {code}" } } });
    expect(edited.layers.find((layer) => layer.id === "code")).toMatchObject({ text: "Мой код: {code}", x: 80, y: 600, size: 64 });
    expect(template.layers.find((layer) => layer.id === "code")).toMatchObject({ text: "Код: {code}" });
  });

  it("текст слоя с partner: none — ошибка с id слоя", () => {
    const error = fails(() => applyPartnerEdits(baseDoc(), { layers: { title: { text: "Хак" } } }));
    expect(error.layerId).toBe("title");
    expect(error.message).toContain("title");
  });

  it("сдвиг x — ошибка с id слоя, даже там, где текст разрешён", () => {
    const error = fails(() => applyPartnerEdits(baseDoc(), { layers: { code: { x: 10 } } }));
    expect(error.layerId).toBe("code");
    expect(error.message).toContain("x");
  });

  it("размер, шрифт, порядок и скрытие партнёр не меняет никогда", () => {
    for (const field of ["width", "height", "y", "size", "font", "rotation", "opacity", "hidden", "partner", "id", "type"]) {
      const error = fails(() => applyPartnerEdits(baseDoc(), { layers: { code: { [field]: 1 } } }));
      expect(error.layerId, field).toBe("code");
    }
  });

  it("слоя с таким id нет — ошибка", () => {
    const error = fails(() => applyPartnerEdits(baseDoc(), { layers: { ghost: { text: "а" } } }));
    expect(error.layerId).toBe("ghost");
  });

  it("текст длиннее 300 знаков — ошибка", () => {
    const error = fails(() => applyPartnerEdits(baseDoc(), { layers: { code: { text: "а".repeat(301) } } }));
    expect(error.layerId).toBe("code");
  });

  it("цвет из палитры принят (без учёта регистра), не из палитры — ошибка", () => {
    const doc = baseDoc();
    const title = doc.layers[0];
    title.partner = "color";
    const ok = applyPartnerEdits(doc, { layers: { title: { color: "#FFB347" } } });
    expect(ok.layers[0]).toMatchObject({ color: "#ffb347" });
    const error = fails(() => applyPartnerEdits(doc, { layers: { title: { color: "#123456" } } }));
    expect(error.layerId).toBe("title");
  });

  it("цвет у rect меняет заливку, у qr — цвет модулей", () => {
    const doc = baseDoc();
    doc.layers.push({ id: "box", type: "rect", x: 0, y: 0, width: 50, height: 50, fill: "#000000", radius: 0, strokeWidth: 0, partner: "color" } as never);
    const qr = doc.layers.find((layer) => layer.id === "qr")!;
    qr.partner = "color";
    const edited = applyPartnerEdits(doc, { layers: { box: { color: "#ffffff" }, qr: { color: "#ffb347" } } });
    expect(edited.layers.find((layer) => layer.id === "box")).toMatchObject({ fill: "#ffffff" });
    expect(edited.layers.find((layer) => layer.id === "qr")).toMatchObject({ fg: "#ffb347" });
  });

  it("цвет у слоя без цвета (значок) — ошибка", () => {
    const doc = baseDoc();
    doc.layers.find((layer) => layer.id === "logo")!.partner = "color";
    expect(fails(() => applyPartnerEdits(doc, { layers: { logo: { color: "#ffb347" } } })).layerId).toBe("logo");
  });

  it("картинку можно заменить только локальным фото и только там, где разрешено", () => {
    const doc = baseDoc();
    doc.layers.push({ id: "pic", type: "image", x: 0, y: 0, width: 100, height: 100, src: { media: "stock" }, partner: "image" } as never);
    const edited = applyPartnerEdits(doc, { layers: { pic: { src: { local: true } } } });
    expect(edited.layers.find((layer) => layer.id === "pic")).toMatchObject({ src: { local: true } });
    expect(fails(() => applyPartnerEdits(doc, { layers: { pic: { src: { media: "other" } } } })).layerId).toBe("pic");
    expect(fails(() => applyPartnerEdits(doc, { layers: { title: { src: { local: true } } } })).layerId).toBe("title");
  });

  it("пустые правки возвращают копию документа", () => {
    const template = baseDoc();
    const edited = applyPartnerEdits(template, {});
    expect(edited).toEqual(template);
    expect(edited).not.toBe(template);
  });
});
