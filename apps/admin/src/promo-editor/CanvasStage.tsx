import { useEffect, useRef, useState } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import { FORMATS, type PromoDoc } from "@bh/promo-kit";
import { CanvasController, type GuideLines, type PendingMark } from "./canvas-controller";
import type { ObjectContext, ObjectSpec } from "./fabric-doc";
import type { UrlResolver } from "./fabric-objects";
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, clampZoom, fitZoom } from "./zoom";
import { IconButton } from "./controls";

/**
 * Холст редактора промо в окне с прокруткой, масштабом и «Вписать»
 * (tasks/T-0274). Fabric живёт в `CanvasController`; здесь — только его
 * хозяйство в React: создать холст, вовремя позвать `sync`, нарисовать
 * направляющие и рамки поверх.
 */
export interface StageProps {
  /** с подставленными переменными: что рисуется */
  view: PromoDoc;
  /** как есть: что правят */
  raw: PromoDoc;
  ctx: ObjectContext;
  urls: UrlResolver;
  pending: readonly string[];
  selected: string | null;
  onSelect(layerId: string | null): void;
  onChange(layerId: string, spec: ObjectSpec): void;
  onEditText(layerId: string, text: string, spec: ObjectSpec): void;
  onProblem(message: string): void;
}

type ZoomMode = "fit" | number;

export function CanvasStage(props: StageProps) {
  const { view } = props;
  const host = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const controller = useRef<CanvasController | null>(null);
  const [zoomMode, setZoomMode] = useState<ZoomMode>("fit");
  const [fit, setFit] = useState(ZOOM_MIN);
  const [guides, setGuides] = useState<GuideLines>({ vertical: [], horizontal: [] });
  const [marks, setMarks] = useState<PendingMark[]>([]);

  const { width, height } = FORMATS[view.format];
  const zoom = zoomMode === "fit" ? fit : zoomMode;

  // Обработчики холста всегда видят свежие свойства — без пересоздания холста при каждой правке.
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    // Свой <canvas> на каждый запуск: Fabric не любит второй раз выходить на тот же элемент (двойной запуск эффектов в разработке).
    const canvas = document.createElement("canvas");
    element.appendChild(canvas);
    const next = new CanvasController(canvas, {
      select: (id) => latest.current.onSelect(id),
      change: (id, spec) => latest.current.onChange(id, spec),
      editText: (id, text, spec) => latest.current.onEditText(id, text, spec),
      guides: setGuides,
      marks: setMarks,
      problem: (message) => latest.current.onProblem(message),
    });
    controller.current = next;
    return () => {
      controller.current = null;
      next.dispose();
      element.replaceChildren();
    };
  }, []);

  // «Вписать» следит за окном: панель меняют по ширине, и холст не должен выпирать.
  useEffect(() => {
    const element = viewport.current;
    if (element === null) return;
    const measure = () => setFit(fitZoom({ width, height }, { width: element.clientWidth - 32, height: element.clientHeight - 32 }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [width, height]);

  useEffect(() => {
    void controller.current
      ?.sync({ view: props.view, raw: props.raw, ctx: props.ctx, urls: props.urls, pending: props.pending, selected: props.selected, zoom })
      .catch((error: unknown) => latest.current.onProblem(error instanceof Error ? error.message : "Холст не отрисовался"));
  }, [props.view, props.raw, props.ctx, props.urls, props.pending, props.selected, zoom]);

  const percent = Math.round(zoom * 100);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <IconButton label="Уменьшить" disabled={zoom <= ZOOM_MIN} onClick={() => setZoomMode(clampZoom(Math.round((zoom - ZOOM_STEP) * 100) / 100))}>
          <Minus size={16} aria-hidden />
        </IconButton>
        <span className="min-w-12 text-center text-xs tabular-nums text-text-muted" aria-live="polite">
          {percent} %
        </span>
        <IconButton label="Увеличить" disabled={zoom >= ZOOM_MAX} onClick={() => setZoomMode(clampZoom(Math.round((zoom + ZOOM_STEP) * 100) / 100))}>
          <Plus size={16} aria-hidden />
        </IconButton>
        <button
          type="button"
          aria-pressed={zoomMode === "fit"}
          onClick={() => setZoomMode("fit")}
          className={`inline-flex h-8 items-center gap-1.5 rounded-sm border px-2.5 text-xs ${zoomMode === "fit" ? "border-accent text-text" : "border-border text-text-muted hover:text-text"}`}
        >
          <Maximize2 size={14} aria-hidden />
          Вписать
        </button>
        <span className="ml-auto text-xs text-text-muted">
          {FORMATS[view.format].label}, {width}×{height}
        </span>
      </div>
      <div ref={viewport} className="grid h-[68vh] min-h-[420px] place-items-center overflow-auto rounded-md border border-border bg-surface-sunken p-4">
        {/* Рамка ровно по размеру холста: направляющие и пунктир считаются от её угла. */}
        <div className="relative shrink-0 shadow-lg" style={{ width: width * zoom, height: height * zoom }}>
          <div ref={host} className="absolute inset-0" />
          <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
            {guides.vertical.map((x) => (
              <div key={`v${String(x)}`} className="absolute top-0 bottom-0 w-px bg-secondary" style={{ left: x * zoom }} />
            ))}
            {guides.horizontal.map((y) => (
              <div key={`h${String(y)}`} className="absolute right-0 left-0 h-px bg-secondary" style={{ top: y * zoom }} />
            ))}
            {marks.map((mark) => (
              <div key={mark.layerId} className="absolute border border-dashed border-warning" style={{ left: mark.x, top: mark.y, width: mark.width, height: mark.height }} />
            ))}
          </div>
        </div>
      </div>
      {marks.length > 0 ? <p className="text-xs text-text-muted">Пунктиром обведено то, что подставится при выгрузке: код, ссылка или награда пока без значения.</p> : null}
    </div>
  );
}
