import { describe, expect, it } from "vitest";
import { PartnerEditError, applyPartnerEdits, promoDocSchema, type PromoDoc, type PromoLayer } from "@bh/promo-kit";
import { containFit, coverCrop, layerToObject, normalizeAngle, objectToLayer, pendingLayerIds, viewDoc } from "../src/promo-editor/fabric-doc";
import { createHistory, pushHistory, redo, undo } from "../src/promo-editor/history";
import { exportFileName } from "../src/promo-editor/export";
import { snapBox } from "../src/promo-editor/guides";
import { commandForKey } from "../src/promo-editor/keys";
import { addLayer, duplicateLayer, moveLayer, nextLayerId, removeLayer, renameLayer, updateLayer } from "../src/promo-editor/layer-ops";
import { applyPartnerChange } from "../src/promo-editor/partner-edit";
import { editorProblems } from "../src/promo-editor/problems";
import { qrImageUrl } from "../src/promo-editor/qr-svg";
import { fitZoom, ZOOM_MAX, ZOOM_MIN } from "../src/promo-editor/zoom";
import { photoProblem } from "../src/promo-editor/photo";

// Редактор промо (tasks/T-0274, Р159): документ — источник истины, холст Fabric
// лишь отображение. Всё, что можно проверить без DOM, — чистые функции.

const title: PromoLayer = { id: "title", type: "text", x: 90, y: 200, width: 900, height: 160, text: "Заходи по коду {code}", font: "russo_one", size: 96, weight: 400, color: "#ffffff", align: "center", lineHeight: 1.1, partner: "text" };
const photo: PromoLayer = { id: "photo", type: "image", x: 0, y: 600, width: 1080, height: 600, src: { media: "hero" }, partner: "image" };
const plate: PromoLayer = { id: "plate", type: "rect", x: 60, y: 1500, width: 960, height: 300, fill: "#2a2145", radius: 24, stroke: "#ffb22e", strokeWidth: 4, rotation: 0, opacity: 0.9, partner: "color" };
const qr: PromoLayer = { id: "qr", type: "qr", x: 780, y: 1560, width: 240, height: 240, fg: "#0d0c18", bg: "#ffffff" };
const logo: PromoLayer = { id: "logo", type: "logo", x: 80, y: 80, width: 320, height: 100, variant: "full", rotation: 15, hidden: true };

function sampleDoc(): PromoDoc {
  return { version: 1, format: "story", background: "#120f1e", palette: ["#ffffff", "#ffb22e", "#2a2145"], layers: [photo, plate, title, qr, logo] };
}

describe("перевод слоя в объект Fabric и обратно", () => {
  it("документ из примеров проходит схему", () => {
    expect(promoDocSchema.safeParse(sampleDoc()).success).toBe(true);
  });

  it.each([title, photo, plate, qr, logo])("слой «$id» (вид $type) возвращается тем же", (layer) => {
    const spec = layerToObject(layer, { mode: "team" });
    expect(spec.layerId).toBe(layer.id);
    expect(objectToLayer(spec, layer)).toEqual(layer);
  });

  it("положение — центр слоя, поворот и скрытие переведены", () => {
    const spec = layerToObject(logo, { mode: "team" });
    expect(spec.left).toBe(240);
    expect(spec.top).toBe(130);
    expect(spec.angle).toBe(15);
    expect(spec.visible).toBe(false);
    expect(spec.scaleX).toBe(1);
  });

  it("масштаб Fabric сводится к размеру слоя, а не копится", () => {
    const spec = layerToObject(plate, { mode: "team" });
    const layer = objectToLayer({ ...spec, scaleX: 2, scaleY: 0.5 }, plate);
    expect(layer).toMatchObject({ width: 1920, height: 150 });
  });

  it("текст: угловой масштаб меняет кегль, боковая ручка — только ширину", () => {
    const spec = layerToObject(title, { mode: "team" });
    const corner = objectToLayer({ ...spec, scaleX: 0.5, scaleY: 0.5 }, title);
    expect(corner).toMatchObject({ width: 450, size: 48 });
    const side = objectToLayer({ ...spec, scaleX: 0.5, scaleY: 1 }, title);
    expect(side).toMatchObject({ width: 450, size: 96 });
  });

  it("кегль после масштаба остаётся в пределах схемы", () => {
    const spec = layerToObject(title, { mode: "team" });
    const layer = objectToLayer({ ...spec, scaleX: 10, scaleY: 10 }, title);
    expect(promoDocSchema.safeParse({ ...sampleDoc(), layers: [layer] }).success).toBe(true);
  });

  it("QR остаётся квадратным при любом масштабе", () => {
    const spec = layerToObject(qr, { mode: "team" });
    const layer = objectToLayer({ ...spec, scaleX: 1.5, scaleY: 1 }, qr);
    expect(layer.width).toBe(layer.height);
  });

  it("поворот приводится к −180…180, значения округляются", () => {
    expect(normalizeAngle(190)).toBe(-170);
    expect(normalizeAngle(-190)).toBe(170);
    expect(normalizeAngle(360)).toBe(0);
    const spec = layerToObject(plate, { mode: "team" });
    const layer = objectToLayer({ ...spec, left: 540.00000001, angle: 370 }, plate);
    expect(layer.x).toBe(60);
    expect(layer.rotation).toBe(10);
  });

  it("режим партнёра: слой без права не выбирается, с правом — выбирается, но не двигается", () => {
    const none = layerToObject(qr, { mode: "partner" });
    expect(none.interaction).toBe("none");
    const allowed = layerToObject(title, { mode: "partner" });
    expect(allowed.interaction).toBe("select");
    expect(allowed.kind === "text" && allowed.editable).toBe(true);
    const colorOnly = layerToObject(plate, { mode: "partner" });
    expect(colorOnly.interaction).toBe("select");
  });

  it("режим команды: слой двигается, закреплённый — только выбирается", () => {
    expect(layerToObject(title, { mode: "team" }).interaction).toBe("full");
    expect(layerToObject(title, { mode: "team", locked: new Set(["title"]) }).interaction).toBe("select");
  });
});

describe("вписывание картинки в рамку слоя", () => {
  it("cover: лишнее обрезается по центру, масштаб один на обе оси", () => {
    const crop = coverCrop({ width: 2000, height: 1000 }, { width: 500, height: 500 });
    expect(crop.scale).toBe(0.5);
    expect(crop.width * crop.scale).toBe(500);
    expect(crop.height * crop.scale).toBe(500);
    expect(crop.cropX).toBe(500);
    expect(crop.cropY).toBe(0);
  });

  it("contain: целиком внутри рамки", () => {
    expect(containFit({ width: 400, height: 100 }, { width: 200, height: 200 })).toEqual({ width: 200, height: 50 });
  });
});

describe("переменные на холсте", () => {
  it("на холсте подставлены значения, а где их нет — видно {code}", () => {
    const view = viewDoc(sampleDoc(), { code: "ЗИМА25" });
    expect(view.layers.find((layer) => layer.id === "title")).toMatchObject({ text: "Заходи по коду ЗИМА25" });
    const bare = viewDoc(sampleDoc(), {});
    expect(bare.layers.find((layer) => layer.id === "title")).toMatchObject({ text: "Заходи по коду {code}" });
  });

  it("слой с неподставленной переменной помечается; QR без ссылки — тоже", () => {
    expect(pendingLayerIds(sampleDoc(), {})).toEqual(["title", "qr"]);
    expect(pendingLayerIds(sampleDoc(), { code: "ЗИМА25", link: "https://t.me/bot" })).toEqual([]);
  });

  it("скрытый слой не помечается", () => {
    const doc = sampleDoc();
    doc.layers = doc.layers.map((layer) => (layer.id === "title" ? { ...layer, hidden: true } : layer));
    expect(pendingLayerIds(doc, { link: "https://t.me/bot" })).toEqual([]);
  });
});

describe("стопка отмены", () => {
  it("51 шаг — самый старый вытеснен, отмен не больше 50", () => {
    let history = createHistory(0);
    for (let step = 1; step <= 51; step += 1) history = pushHistory(history, step);
    expect(history.past).toHaveLength(50);
    let undone = 0;
    while (history.past.length > 0) {
      history = undo(history);
      undone += 1;
    }
    expect(undone).toBe(50);
    // нулевого шага уже нет: дальше всех отматывается первый
    expect(history.present).toBe(1);
  });

  it("отмена и повтор ходят туда и обратно", () => {
    let history = createHistory("a");
    history = pushHistory(history, "b");
    history = pushHistory(history, "c");
    history = undo(history);
    expect(history.present).toBe("b");
    history = redo(history);
    expect(history.present).toBe("c");
    expect(redo(history)).toBe(history);
  });

  it("новая правка после отмены обрывает повтор", () => {
    let history = createHistory("a");
    history = pushHistory(history, "b");
    history = undo(history);
    history = pushHistory(history, "c");
    expect(history.future).toEqual([]);
    expect(redo(history).present).toBe("c");
  });

  it("правки с одним ключом склеиваются в один шаг, чужой ключ — новый шаг", () => {
    let history = createHistory("a");
    history = pushHistory(history, "b", "title:text");
    history = pushHistory(history, "bb", "title:text");
    history = pushHistory(history, "bbb", "title:text");
    expect(history.past).toEqual(["a"]);
    history = pushHistory(history, "x", "plate:fill");
    expect(history.past).toEqual(["a", "bbb"]);
    history = pushHistory(history, "y");
    history = pushHistory(history, "z");
    expect(history.past).toEqual(["a", "bbb", "x", "y"]);
  });

  it("отмена обрывает склейку: следующая правка — новый шаг", () => {
    let history = createHistory("a");
    history = pushHistory(history, "b", "k");
    history = undo(history);
    history = redo(history);
    history = pushHistory(history, "c", "k");
    expect(history.past).toEqual(["a", "b"]);
  });
});

describe("режим партнёра: правки идут через applyPartnerEdits", () => {
  const template = sampleDoc();

  it("правка положения отклоняется, документ не меняется", () => {
    expect(() => applyPartnerEdits(template, { layers: { title: { x: 5 } } })).toThrow(PartnerEditError);
    const result = applyPartnerChange(template, null, { layerId: "title", field: "x", value: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("title");
  });

  it("слой без права менять нельзя ничем", () => {
    const result = applyPartnerChange(template, null, { layerId: "qr", field: "color", value: "#ffffff" });
    expect(result.ok).toBe(false);
  });

  it("текст слоя с правом меняется, правки копятся", () => {
    const first = applyPartnerChange(template, null, { layerId: "title", field: "text", value: "Привет, друг! {code}" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyPartnerChange(template, first.edits, { layerId: "plate", field: "color", value: "#FFB22E" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.doc.layers.find((layer) => layer.id === "title")).toMatchObject({ text: "Привет, друг! {code}" });
    expect(second.doc.layers.find((layer) => layer.id === "plate")).toMatchObject({ fill: "#ffb22e" });
    // шаблон не тронут
    expect(template.layers.find((layer) => layer.id === "title")).toMatchObject({ text: "Заходи по коду {code}" });
  });

  it("цвет не из палитры отклоняется", () => {
    const result = applyPartnerChange(template, null, { layerId: "plate", field: "color", value: "#123456" });
    expect(result.ok).toBe(false);
  });

  it("своё фото — только {local: true}", () => {
    const ok = applyPartnerChange(template, null, { layerId: "photo", field: "src", value: { local: true } });
    expect(ok.ok).toBe(true);
    const bad = applyPartnerChange(template, null, { layerId: "photo", field: "src", value: { media: "other" } });
    expect(bad.ok).toBe(false);
  });
});

describe("своё фото партнёра", () => {
  it("PNG, JPEG и WebP до предела проходят", () => {
    expect(photoProblem({ type: "image/png", size: 2_000_000 })).toBeNull();
    expect(photoProblem({ type: "image/jpeg", size: 2_000_000 })).toBeNull();
    expect(photoProblem({ type: "image/webp", size: 2_000_000 })).toBeNull();
  });

  it("SVG и чужие типы отклоняются: в картинке не должно быть скриптов", () => {
    expect(photoProblem({ type: "image/svg+xml", size: 1000 })).not.toBeNull();
    expect(photoProblem({ type: "text/html", size: 1000 })).not.toBeNull();
    expect(photoProblem({ type: "", size: 1000 })).not.toBeNull();
  });

  it("огромный файл отклоняется", () => {
    expect(photoProblem({ type: "image/png", size: 100 * 1024 * 1024 })).not.toBeNull();
  });
});

describe("имя файла выгрузки", () => {
  it("код с пробелом — через дефис, кириллица сохраняется", () => {
    expect(exportFileName("story", "ЗИМА 25", "png")).toBe("rubezh-story-ЗИМА-25.png");
  });

  it("без кода — pres, JPEG — .jpg", () => {
    expect(exportFileName("square", undefined, "jpeg")).toBe("rubezh-square-pres.jpg");
    expect(exportFileName("wide", "   ", "png")).toBe("rubezh-wide-pres.png");
  });

  it("лишние знаки уходят — имя файла не выйдет за каталог", () => {
    expect(exportFileName("story", "../../etc/passwd", "png")).toBe("rubezh-story-etcpasswd.png");
    expect(exportFileName("story", "A\\B:C*D", "png")).toBe("rubezh-story-ABCD.png");
  });
});

describe("направляющие", () => {
  const canvas = { width: 1080, height: 1920 };

  it("центр слоя липнет к центру холста", () => {
    const result = snapBox({ x: 193, y: 100, width: 700, height: 100 }, canvas, 8);
    expect(result.dx).toBe(-3);
    expect(result.vertical).toEqual([540]);
  });

  it("край липнет к краю холста", () => {
    const result = snapBox({ x: 5, y: 1815, width: 300, height: 100 }, canvas, 8);
    expect(result.dx).toBe(-5);
    expect(result.dy).toBe(5);
    expect(result.vertical).toEqual([0]);
    expect(result.horizontal).toEqual([1920]);
  });

  it("далеко — не липнет, направляющих нет", () => {
    const result = snapBox({ x: 100, y: 100, width: 200, height: 200 }, canvas, 8);
    expect(result).toEqual({ dx: 0, dy: 0, vertical: [], horizontal: [] });
  });
});

describe("клавиши", () => {
  const key = (init: Partial<Parameters<typeof commandForKey>[0]>) => commandForKey({ key: "", code: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init });

  it("Delete — удалить", () => {
    expect(key({ key: "Delete" })).toEqual({ type: "delete" });
  });

  it("Ctrl/Cmd+Z — отмена, с Shift и Ctrl+Y — повтор", () => {
    expect(key({ key: "z", code: "KeyZ", ctrlKey: true })).toEqual({ type: "undo" });
    expect(key({ key: "z", code: "KeyZ", metaKey: true })).toEqual({ type: "undo" });
    expect(key({ key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true })).toEqual({ type: "redo" });
    expect(key({ key: "y", code: "KeyY", ctrlKey: true })).toEqual({ type: "redo" });
  });

  it("на русской раскладке работает по коду клавиши", () => {
    expect(key({ key: "я", code: "KeyZ", ctrlKey: true })).toEqual({ type: "undo" });
    expect(key({ key: "в", code: "KeyD", ctrlKey: true })).toEqual({ type: "duplicate" });
  });

  it("стрелки — на 1, с Shift — на 10", () => {
    expect(key({ key: "ArrowLeft" })).toEqual({ type: "nudge", dx: -1, dy: 0 });
    expect(key({ key: "ArrowDown", shiftKey: true })).toEqual({ type: "nudge", dx: 0, dy: 10 });
    expect(key({ key: "ArrowUp" })).toEqual({ type: "nudge", dx: 0, dy: -1 });
    expect(key({ key: "ArrowRight", shiftKey: true })).toEqual({ type: "nudge", dx: 10, dy: 0 });
  });

  it("обычная буква и Ctrl+Alt+Z — не команды", () => {
    expect(key({ key: "z", code: "KeyZ" })).toBeNull();
    expect(key({ key: "z", code: "KeyZ", ctrlKey: true, altKey: true })).toBeNull();
  });
});

describe("операции над слоями", () => {
  it("новый слой получает свободный id и ложится сверху", () => {
    const doc = sampleDoc();
    const result = addLayer(doc, "text");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.layers.at(-1)?.type).toBe("text");
    const ids = result.doc.layers.map((layer) => layer.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(promoDocSchema.safeParse(result.doc).success).toBe(true);
  });

  it("каждый вид добавляется и проходит схему", () => {
    for (const kind of ["text", "image", "rect", "qr", "logo"] as const) {
      const result = addLayer(sampleDoc(), kind);
      expect(result.ok).toBe(true);
      if (result.ok) expect(promoDocSchema.safeParse(result.doc).success).toBe(true);
    }
  });

  it("больше 40 слоёв не добавить — с причиной", () => {
    let doc = sampleDoc();
    for (let step = 0; step < 60; step += 1) {
      const result = addLayer(doc, "rect");
      if (!result.ok) {
        expect(result.message).toContain("40");
        expect(doc.layers).toHaveLength(40);
        return;
      }
      doc = result.doc;
    }
    throw new Error("предел слоёв не сработал");
  });

  it("id не повторяется и укладывается в 24 знака", () => {
    const doc = sampleDoc();
    expect(nextLayerId(doc, "text")).toMatch(/^[a-z0-9_]{1,24}$/);
    const taken = { ...doc, layers: [{ ...title, id: "text_1" }, { ...title, id: "text_2" }] };
    expect(nextLayerId(taken, "text")).toBe("text_3");
  });

  it("копия — со сдвигом, сразу над оригиналом, с новым id", () => {
    const result = duplicateLayer(sampleDoc(), "plate");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const index = result.doc.layers.findIndex((layer) => layer.id === "plate");
    const copy = result.doc.layers[index + 1];
    expect(copy).toMatchObject({ type: "rect", x: 80, y: 1520 });
    expect(copy?.id).not.toBe("plate");
    expect(result.id).toBe(copy?.id);
  });

  it("поднять и опустить меняют порядок; на краю — без изменений", () => {
    const doc = sampleDoc();
    expect(moveLayer(doc, "photo", "down")).toBe(doc);
    expect(moveLayer(doc, "logo", "up")).toBe(doc);
    expect(moveLayer(doc, "photo", "up").layers.map((layer) => layer.id)).toEqual(["plate", "photo", "title", "qr", "logo"]);
    expect(moveLayer(doc, "logo", "down").layers.map((layer) => layer.id)).toEqual(["photo", "plate", "title", "logo", "qr"]);
  });

  it("удаление убирает слой, переименование проверяет id", () => {
    const doc = sampleDoc();
    expect(removeLayer(doc, "qr").layers.map((layer) => layer.id)).not.toContain("qr");
    expect(renameLayer(doc, "qr", "code_qr")).toMatchObject({ ok: true });
    expect(renameLayer(doc, "qr", "Плохой id")).toMatchObject({ ok: false });
    expect(renameLayer(doc, "qr", "title")).toMatchObject({ ok: false });
    expect(renameLayer(doc, "qr", "qr")).toMatchObject({ ok: true });
  });

  it("правка слоя не трогает остальные", () => {
    const doc = sampleDoc();
    const next = updateLayer(doc, "title", { color: "#ffb22e" });
    expect(next.layers.find((layer) => layer.id === "title")).toMatchObject({ color: "#ffb22e" });
    expect(next.layers.find((layer) => layer.id === "plate")).toBe(doc.layers.find((layer) => layer.id === "plate"));
    expect(doc.layers.find((layer) => layer.id === "title")).toMatchObject({ color: "#ffffff" });
  });
});

describe("QR картинкой из SVG", () => {
  it("тёмный на светлом, с полем тишины в четыре модуля", () => {
    const url = qrImageUrl("https://t.me/rubezh_bot?start=ref_abc", "#0d0c18", "#ffffff", 240);
    expect(url).not.toBeNull();
    expect(url?.startsWith("data:image/svg+xml")).toBe(true);
    const svg = decodeURIComponent((url ?? "").replace(/^data:image\/svg\+xml;charset=utf-8,/, ""));
    expect(svg).toContain('width="240"');
    expect(svg).toContain('fill="#0d0c18"');
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).not.toContain("<script");
  });

  it("цвет не вида #rrggbb в разметку не попадает", () => {
    expect(qrImageUrl("x", '"/><script>', "#ffffff", 100)).toBeNull();
  });

  it("слишком длинный адрес — null, а не исключение", () => {
    expect(qrImageUrl("a".repeat(5000), "#000000", "#ffffff", 100)).toBeNull();
  });
});

describe("предупреждения перед выгрузкой", () => {
  it("слабый контраст QR и светлый на тёмном — предупреждение; обычный QR — нет", () => {
    const doc = sampleDoc();
    expect(editorProblems(doc)).toEqual([]);
    const weak = { ...doc, layers: doc.layers.map((layer) => (layer.type === "qr" ? { ...layer, fg: "#cccccc" } : layer)) };
    expect(editorProblems(weak).join(" ")).toContain("QR");
    const inverted = { ...doc, layers: doc.layers.map((layer) => (layer.type === "qr" ? { ...layer, fg: "#ffffff", bg: "#0d0c18" } : layer)) };
    expect(editorProblems(inverted).join(" ")).toContain("QR");
  });

  it("предупреждения модели (слой за холстом) тоже в списке", () => {
    const doc = sampleDoc();
    const away = { ...doc, layers: doc.layers.map((layer) => (layer.id === "plate" ? { ...layer, x: 5000 } : layer)) };
    expect(editorProblems(away).join(" ")).toContain("plate");
  });
});

describe("масштаб холста", () => {
  it("вписать — в доступное окно, но в пределах 25…200 %", () => {
    expect(fitZoom({ width: 1080, height: 1920 }, { width: 540, height: 960 })).toBe(0.5);
    expect(fitZoom({ width: 1080, height: 1920 }, { width: 100, height: 100 })).toBe(ZOOM_MIN);
    expect(fitZoom({ width: 100, height: 100 }, { width: 1000, height: 1000 })).toBe(ZOOM_MAX);
    expect(fitZoom({ width: 1080, height: 1920 }, { width: 0, height: 0 })).toBe(ZOOM_MIN);
  });
});
