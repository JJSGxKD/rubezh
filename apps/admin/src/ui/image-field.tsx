import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject, type WheelEvent } from "react";
import { IMAGE_MAX_BYTES, IMAGE_PROFILES, imageUrl, uploadImage, type ImageProfileId } from "../api/media";
import { api } from "../services";
import { Dialog } from "./dialog";
import { CENTERED, SOURCE_TYPES, cropOf, encodeWithin, maxZoom, outputSide, panBy, sizeProblem, sourceProblem, zoomTo, type CropRect, type Framing } from "./image-crop";
import { Button, Help, Notice } from "./kit";

/**
 * Картинка из панели (docs/35-stage4-plan.md Р82, О42): выбрать файл,
 * обрезать квадратом и сохранить. Сжимает панель — в WebP до 200 КБ, сервер
 * только проверяет. Результат видно сразу в том размере, в каком его увидит
 * игрок.
 *
 * Своя подпись, а не `Field`: тот оборачивает поле в `<label>`, и нажатие на
 * подпись нажимало бы первую кнопку.
 */
export function ImageField({ label, help, profile, value, onChange }: { label: string; help?: string; profile: ImageProfileId; value: string | null; onChange: (imageId: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<ImageBitmap | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Загруженная, но ещё не сохранённая с заданием: без напоминания её легко
  // оставить в форме и решить, что игроки её уже видят.
  const [uploaded, setUploaded] = useState<string | null>(null);
  const { shownAs, minSide } = IMAGE_PROFILES[profile];

  const pick = async (file: File | undefined): Promise<void> => {
    // Тот же файл можно выбрать снова — после отмены обрезки.
    if (input.current !== null) input.current.value = "";
    if (file === undefined) return;
    const unfit = sourceProblem(file);
    if (unfit !== null) return setProblem(unfit);
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      return setProblem("Не получилось открыть файл — он повреждён или это не PNG, JPEG и не WebP");
    }
    const small = sizeProblem(bitmap, minSide);
    if (small !== null) {
      bitmap.close();
      return setProblem(small);
    }
    setProblem(null);
    setSource(bitmap);
  };

  const closeCrop = (): void => {
    source?.close();
    setSource(null);
  };

  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-xs text-text-muted">
        {label}
        {help === undefined ? null : <Help text={help} />}
      </span>
      <div className="flex items-center gap-3">
        <Thumb imageId={value} />
        <div className="flex flex-col gap-1">
          <div className="flex gap-2">
            <Button onClick={() => input.current?.click()}>{value === null ? "Загрузить…" : "Заменить…"}</Button>
            {value === null ? null : <Button onClick={() => onChange(null)}>Убрать</Button>}
          </div>
          {value !== null && value === uploaded ? (
            <span className="text-xs text-warning">загружена — нажмите «Сохранить», чтобы игроки её увидели</span>
          ) : (
            <span className="text-xs text-text-disabled">{value === null ? "нет — у игрока значок вида" : shownAs}</span>
          )}
        </div>
      </div>
      {problem === null ? null : (
        <span role="alert" className="text-xs text-danger">
          {problem}
        </span>
      )}
      <input ref={input} type="file" accept={SOURCE_TYPES.join(",")} className="hidden" onChange={(event) => void pick(event.target.files?.[0])} />
      {source === null ? null : (
        <CropDialog
          source={source}
          profile={profile}
          onClose={closeCrop}
          onUploaded={(imageId) => {
            setUploaded(imageId);
            onChange(imageId);
            closeCrop();
          }}
        />
      )}
    </div>
  );
}

/** Сохранённая картинка в размере игрока; не загрузилась — так и сказано, а не пустой квадрат. */
function Thumb({ imageId }: { imageId: string | null }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [imageId]);
  const box = "size-11 shrink-0 rounded-md border border-border bg-surface-sunken";
  if (imageId === null) return <span className={box} aria-hidden="true" />;
  if (broken) return <span className={`${box} flex items-center justify-center text-center text-[10px] leading-tight text-danger`}>не грузится</span>;
  return <img src={imageUrl(imageId)} alt="Картинка задания" width={44} height={44} onError={() => setBroken(true)} className={`${box} object-cover`} />;
}

/** Кадр в диалоге — CSS-пиксели; холст вдвое плотнее, чтобы на экране с плотностью 2 не мылило. */
const FRAME = 288;
const DENSITY = 2;
/** Шаг стрелок, точки кадра. */
const KEY_STEP = 8;
const WHEEL_STEP = 1.1;

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "failed"; problem: string };

function CropDialog({ source, profile, onClose, onUploaded }: { source: ImageBitmap; profile: ImageProfileId; onClose: () => void; onUploaded: (imageId: string) => void }) {
  const { minSide, side: profileSide, shownAs } = IMAGE_PROFILES[profile];
  const size = { width: source.width, height: source.height };
  const [framing, setFraming] = useState<Framing>(CENTERED);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const frame = useRef<HTMLCanvasElement>(null);
  const small = useRef<HTMLCanvasElement>(null);
  const large = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  const crop = cropOf(size, framing, minSide);
  const zoomLimit = maxZoom(size, minSide);
  const side = outputSide(crop, profileSide);
  const saving = state.kind === "saving";

  // Без списка зависимостей: Radix монтирует содержимое диалога в портал
  // вторым проходом, и на первом холстов ещё нет. Рисовать три маленьких
  // холста на каждую отрисовку дёшево, а отрисовок здесь — только от кадра.
  useEffect(() => {
    for (const canvas of [frame.current, small.current, large.current]) paint(canvas, source, crop);
  });

  const pan = (dx: number, dy: number): void => setFraming((current) => panBy(size, current, minSide, dx, dy, FRAME));
  const zoom = (next: number): void => setFraming((current) => zoomTo(size, current, minSide, next));

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>): void => {
    if (drag.current === null) return;
    pan(event.clientX - drag.current.x, event.clientY - drag.current.y);
    drag.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (): void => {
    drag.current = null;
  };
  const onWheel = (event: WheelEvent<HTMLCanvasElement>): void => zoom(framing.zoom * (event.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP));
  const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>): void => {
    const moves: Record<string, [number, number]> = { ArrowLeft: [KEY_STEP, 0], ArrowRight: [-KEY_STEP, 0], ArrowUp: [0, KEY_STEP], ArrowDown: [0, -KEY_STEP] };
    const move = moves[event.key];
    if (move !== undefined) pan(move[0], move[1]);
    else if (event.key === "+" || event.key === "=") zoom(framing.zoom * WHEEL_STEP);
    else if (event.key === "-") zoom(framing.zoom / WHEEL_STEP);
    else return;
    event.preventDefault();
  };

  const save = async (): Promise<void> => {
    setState({ kind: "saving" });
    const out = document.createElement("canvas");
    out.width = side;
    out.height = side;
    paint(out, source, crop);
    const encoded = await encodeWithin((quality) => new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/webp", quality)), IMAGE_MAX_BYTES);
    if (!encoded.ok) return setState({ kind: "failed", problem: encoded.problem });
    const result = await uploadImage(api, profile, encoded.blob);
    if (!result.ok) return setState({ kind: "failed", problem: result.error.message });
    onUploaded(result.data.imageId);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
      title="Картинка: обрезка квадратом"
      description="Перетащите картинку, чтобы в квадрат попало главное; колесо или ползунок — приближение. Справа — как увидит игрок."
      footer={
        <>
          <Button onClick={() => setFraming(CENTERED)} disabled={saving} className="mr-auto">
            По центру
          </Button>
          <Button onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button tone="primary" onClick={() => void save()} disabled={saving}>
            {saving ? "Сохраняю…" : "Сохранить картинку"}
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap items-start gap-5">
        <div className="flex flex-col gap-2">
          <canvas
            ref={frame}
            width={FRAME * DENSITY}
            height={FRAME * DENSITY}
            tabIndex={0}
            aria-label="Кадр картинки: перетаскивайте мышью или стрелками, плюс и минус — приближение"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
            onKeyDown={onKeyDown}
            style={{ width: FRAME, height: FRAME }}
            className="cursor-grab touch-none rounded-md border border-border bg-surface-sunken focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent active:cursor-grabbing"
          />
          <label className="flex items-center gap-2 text-xs text-text-muted">
            Приближение
            <input
              type="range"
              min={1}
              max={zoomLimit}
              step={0.01}
              value={Math.min(framing.zoom, zoomLimit)}
              disabled={zoomLimit <= 1}
              onChange={(event) => zoom(Number(event.target.value))}
              className="flex-1 accent-accent"
            />
          </label>
          {zoomLimit <= 1 ? <span className="text-xs text-text-disabled">приближать некуда: короче стороны уже не взять</span> : null}
        </div>
        <div className="flex flex-col gap-4">
          <Preview canvas={small} side={44} caption={shownAs} />
          <Preview canvas={large} side={88} caption="крупно — видно огрехи обрезки" />
          <p className="max-w-56 text-xs text-text-muted">
            Сохранится {String(side)}×{String(side)} WebP до {String(IMAGE_MAX_BYTES / 1024)} КБ. Из исходника {String(size.width)}×{String(size.height)} берётся квадрат{" "}
            {String(Math.round(crop.side))} px.
          </p>
        </div>
      </div>
      {state.kind === "failed" ? (
        <div className="mt-3">
          <Notice>{state.problem}</Notice>
        </div>
      ) : null}
    </Dialog>
  );
}

function Preview({ canvas, side, caption }: { canvas: RefObject<HTMLCanvasElement | null>; side: number; caption: string }) {
  return (
    <figure className="flex items-center gap-3">
      <canvas ref={canvas} width={side * DENSITY} height={side * DENSITY} style={{ width: side, height: side }} className="shrink-0 rounded-md bg-surface-sunken" />
      <figcaption className="text-xs text-text-muted">{caption}</figcaption>
    </figure>
  );
}

/** Квадрат кадра — во весь холст. */
function paint(canvas: HTMLCanvasElement | null, source: ImageBitmap, crop: CropRect): void {
  const context = canvas?.getContext("2d");
  if (canvas === null || context === null || context === undefined) return;
  context.imageSmoothingQuality = "high";
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, crop.x, crop.y, crop.side, crop.side, 0, 0, canvas.width, canvas.height);
}
