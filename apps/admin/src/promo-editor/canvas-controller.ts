import { Canvas, Textbox, type FabricObject, type IText } from "fabric";
import { FORMATS, type PromoDoc } from "@bh/promo-kit";
import { layerToObject, type ObjectContext, type ObjectSpec } from "./fabric-doc";
import { applySpec, createObject, loadBackground, loadFonts, metaOf, paintBackground, readSpec, signatureOf, type UrlResolver } from "./fabric-objects";
import { SNAP_SCREEN_PX, snapBox } from "./guides";

/**
 * Холст редактора промо (tasks/T-0274): связывает холст Fabric с документом.
 * Документ — источник истины: `sync` приводит холст к нему, а всё, что
 * человек сделал мышью, уходит наружу событиями — `change` и `editText`, —
 * и возвращается уже новым документом. Fabric-JSON нигде не хранится.
 *
 * React не знает о Fabric, а Fabric — о React: компонент только вызывает
 * `sync` и слушает события.
 */

export interface GuideLines {
  vertical: number[];
  horizontal: number[];
}

/** Рамка слоя с неподставленной переменной, экранных точек от верхнего левого угла холста. */
export interface PendingMark {
  layerId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ControllerEvents {
  select(layerId: string | null): void;
  /** объект подвинули, повернули или изменили размер */
  change(layerId: string, spec: ObjectSpec): void;
  /** закончили править текст на холсте; `text` — сырой, с `{code}` */
  editText(layerId: string, text: string, spec: ObjectSpec): void;
  guides(lines: GuideLines): void;
  marks(marks: PendingMark[]): void;
  /** ошибка, которую стоит показать (не загрузилась картинка фона) */
  problem(message: string): void;
}

export interface SyncInput {
  /** документ с подставленными переменными: то, что рисуется */
  view: PromoDoc;
  /** документ как есть, с `{code}`: то, что правят */
  raw: PromoDoc;
  ctx: ObjectContext;
  urls: UrlResolver;
  /** слои с заглушкой вместо переменной */
  pending: readonly string[];
  selected: string | null;
  zoom: number;
}

const NO_GUIDES: GuideLines = { vertical: [], horizontal: [] };

export class CanvasController {
  private readonly canvas: Canvas;
  private readonly objects = new Map<string, FabricObject>();
  /** описания слоёв из сырого документа: от них считается правка */
  private readonly rawSpecs = new Map<string, ObjectSpec>();
  private run = 0;
  /** пока больше нуля, события холста — наши собственные перестановки, а не действия человека */
  private quiet = 0;
  private zoom = 1;
  private size = { width: 1080, height: 1920 };
  private pending: readonly string[] = [];
  private lastMarks = "";
  private fontsReady = false;
  private disposed = false;
  /** текст, из которого только что вышли: Fabric следом шлёт `modified`, а текст уже ушёл своим событием */
  private leftText: FabricObject | null = null;

  constructor(
    element: HTMLCanvasElement,
    private readonly events: ControllerEvents,
  ) {
    this.canvas = new Canvas(element, {
      // Выбор рамкой и несколько слоёв сразу редактору не нужны: правка идёт слой за слоем.
      selection: false,
      selectionKey: null,
      preserveObjectStacking: true,
      stopContextMenu: true,
      uniformScaling: true,
      enableRetinaScaling: true,
    });
    this.canvas.on("selection:created", ({ selected }) => this.emitSelection(selected));
    this.canvas.on("selection:updated", ({ selected }) => this.emitSelection(selected));
    this.canvas.on("selection:cleared", () => {
      if (this.quiet === 0) this.events.select(null);
    });
    this.canvas.on("object:moving", ({ target }) => this.snap(target));
    this.canvas.on("object:modified", ({ target }) => this.finish(target));
    this.canvas.on("mouse:up", () => this.events.guides(NO_GUIDES));
    this.canvas.on("text:editing:entered", ({ target }) => this.beginText(target));
    this.canvas.on("text:editing:exited", ({ target }) => this.endText(target));
    this.canvas.on("after:render", () => this.emitMarks());
  }

  private emitSelection(selected: readonly FabricObject[]): void {
    if (this.quiet > 0) return;
    const id = selected[0] === undefined ? undefined : metaOf(selected[0])?.layerId;
    this.events.select(id ?? null);
  }

  /** Липнем к центру и краям холста по рамке объекта в сценических координатах. */
  private snap(target: FabricObject): void {
    const bounds = target.getBoundingRect();
    const result = snapBox({ x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height }, this.size, SNAP_SCREEN_PX / this.zoom);
    if (result.dx !== 0 || result.dy !== 0) {
      target.set({ left: target.left + result.dx, top: target.top + result.dy });
      target.setCoords();
    }
    this.events.guides({ vertical: result.vertical, horizontal: result.horizontal });
  }

  private finish(target: FabricObject): void {
    this.events.guides(NO_GUIDES);
    if (this.leftText === target) return;
    const id = metaOf(target)?.layerId;
    const prev = id === undefined ? undefined : this.rawSpecs.get(id);
    if (id === undefined || prev === undefined) return;
    this.events.change(id, readSpec(target, prev));
  }

  /** При правке на холсте показываем сырой текст: переменную `{code}`, а не её значение. */
  private beginText(target: IText): void {
    const id = metaOf(target)?.layerId;
    const prev = id === undefined ? undefined : this.rawSpecs.get(id);
    if (prev?.kind !== "text" || target.text === prev.text) return;
    target.set({ text: prev.text });
    if (target.hiddenTextarea !== null) target.hiddenTextarea.value = prev.text;
    target.setSelectionStart(prev.text.length);
    target.setSelectionEnd(prev.text.length);
    this.canvas.requestRenderAll();
  }

  private endText(target: IText): void {
    const id = metaOf(target)?.layerId;
    const prev = id === undefined ? undefined : this.rawSpecs.get(id);
    if (id === undefined || prev === undefined) return;
    // `modified` приходит в том же вызове сразу за выходом — после него метка снимается.
    this.leftText = target;
    queueMicrotask(() => {
      if (this.leftText === target) this.leftText = null;
    });
    this.events.editText(id, target.text, readSpec(target, prev, { text: true }));
  }

  private emitMarks(): void {
    const marks: PendingMark[] = [];
    for (const id of this.pending) {
      const object = this.objects.get(id);
      if (object === undefined || !object.visible) continue;
      const box = object.getBoundingRect();
      marks.push({ layerId: id, x: Math.round(box.left * this.zoom), y: Math.round(box.top * this.zoom), width: Math.round(box.width * this.zoom), height: Math.round(box.height * this.zoom) });
    }
    const key = JSON.stringify(marks);
    if (key === this.lastMarks) return;
    this.lastMarks = key;
    this.events.marks(marks);
  }

  async sync(input: SyncInput): Promise<void> {
    if (this.disposed) return;
    const token = ++this.run;
    const { view, raw, ctx, urls } = input;

    if (!this.fontsReady) {
      await loadFonts(view.layers.flatMap((layer) => (layer.type === "text" ? [layer.text] : [])));
      this.fontsReady = true;
      if (token !== this.run || this.disposed) return;
    }

    // Сначала всё, что ждёт загрузки, потом — одним куском без пауз: холст не показывает полупереставленный документ.
    const specs = view.layers.map((layer) => layerToObject(layer, ctx));
    const fresh = new Map<string, FabricObject>();
    for (const spec of specs) {
      const known = this.objects.get(spec.layerId);
      if (known !== undefined && metaOf(known)?.signature === signatureOf(spec, urls)) continue;
      fresh.set(spec.layerId, await createObject(spec, urls));
      if (token !== this.run || this.disposed) return;
    }
    const background = await loadBackground(view, urls);
    if (token !== this.run || this.disposed) return;
    if (background.problem !== null) this.events.problem(background.problem);

    this.quiet += 1;
    try {
      this.zoom = input.zoom;
      this.size = { width: FORMATS[view.format].width, height: FORMATS[view.format].height };
      this.pending = input.pending;
      this.canvas.setDimensions({ width: this.size.width * this.zoom, height: this.size.height * this.zoom });
      this.canvas.setZoom(this.zoom);
      paintBackground(this.canvas, view, background.image);

      this.rawSpecs.clear();
      for (const layer of raw.layers) this.rawSpecs.set(layer.id, layerToObject(layer, ctx));

      const alive = new Set<string>();
      specs.forEach((spec, index) => {
        alive.add(spec.layerId);
        const known = this.objects.get(spec.layerId);
        const replacement = fresh.get(spec.layerId);
        let object = known;
        if (replacement !== undefined) {
          if (known !== undefined) this.canvas.remove(known);
          this.canvas.add(replacement);
          this.objects.set(spec.layerId, replacement);
          object = replacement;
        } else if (known !== undefined) {
          applySpec(known, spec);
        }
        if (object !== undefined) this.canvas.moveObjectTo(object, index);
      });
      for (const [id, object] of [...this.objects]) {
        if (alive.has(id)) continue;
        this.canvas.remove(object);
        this.objects.delete(id);
      }

      this.restoreSelection(input.selected);
      this.canvas.requestRenderAll();
    } finally {
      this.quiet -= 1;
    }
  }

  private restoreSelection(selected: string | null): void {
    const object = selected === null ? undefined : this.objects.get(selected);
    if (object === undefined || !object.selectable) {
      if (this.canvas.getActiveObject() !== undefined) this.canvas.discardActiveObject();
      return;
    }
    if (this.canvas.getActiveObject() !== object) this.canvas.setActiveObject(object);
  }

  /** Закончить правку текста на холсте (кнопка «Готово» и смена слоя). */
  stopEditing(): void {
    const active = this.canvas.getActiveObject();
    if (active instanceof Textbox && active.isEditing) active.exitEditing();
  }

  dispose(): void {
    this.disposed = true;
    this.run += 1;
    void this.canvas.dispose();
  }
}
