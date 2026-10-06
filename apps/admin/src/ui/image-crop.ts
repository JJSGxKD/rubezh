/**
 * Кадрирование картинки квадратом в панели (docs/35-stage4-plan.md Р82): что
 * из исходника попадёт в квадрат и как его сжать. Чистые функции — без
 * холста, их проверяют тесты; рисует `image-field.tsx`.
 */

export interface Size {
  width: number;
  height: number;
}

/** Кадр: центр в долях исходника и приближение; 1 — квадрат во всю короткую сторону. */
export interface Framing {
  cx: number;
  cy: number;
  zoom: number;
}

/** Квадрат в точках исходника. */
export interface CropRect {
  x: number;
  y: number;
  side: number;
}

/** Исходник больше — это уже не картинка для строки задания, а фотоархив. */
export const SOURCE_MAX_BYTES = 15 * 1024 * 1024;
export const SOURCE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
/** Дальше приближать незачем: квадрат станет мельче, чем нужно игроку. */
export const ZOOM_MAX = 4;

/** Качество WebP шагами вниз, пока файл не уложится в предел. */
export const QUALITY_STEPS = [0.9, 0.82, 0.74, 0.66, 0.58, 0.5] as const;

export const CENTERED: Framing = { cx: 0.5, cy: 0.5, zoom: 1 };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Что не так с файлом до того, как его открывать; `null` — открывать. */
export function sourceProblem(file: { type: string; size: number }): string | null {
  if (!(SOURCE_TYPES as readonly string[]).includes(file.type)) return "Нужна картинка PNG, JPEG или WebP";
  if (file.size > SOURCE_MAX_BYTES) return `Файл больше ${String(SOURCE_MAX_BYTES / 1024 / 1024)} МБ — уменьшите его`;
  return null;
}

/** Хватит ли исходника: короткая сторона меньше нужного — у игрока будет мыло. */
export function sizeProblem(size: Size, minSide: number): string | null {
  if (Math.min(size.width, size.height) >= minSide) return null;
  return `Картинка ${String(size.width)}×${String(size.height)} — меньше ${String(minSide)} px по короткой стороне, в игре она будет мыльной. Возьмите побольше`;
}

/** Насколько можно приблизить, чтобы квадрат остался не меньше `minSide`. */
export function maxZoom(size: Size, minSide: number): number {
  return clamp(Math.min(size.width, size.height) / minSide, 1, ZOOM_MAX);
}

/** Квадрат кадра в исходнике: не выходит за края, как бы ни двигали. */
export function cropOf(size: Size, framing: Framing, minSide: number): CropRect {
  const zoom = clamp(framing.zoom, 1, maxZoom(size, minSide));
  const side = Math.min(size.width, size.height) / zoom;
  return {
    x: clamp(framing.cx * size.width - side / 2, 0, size.width - side),
    y: clamp(framing.cy * size.height - side / 2, 0, size.height - side),
    side,
  };
}

/** Кадр, который описывает этот квадрат: центр упирается в край, если квадрат упёрся. */
function framingOf(size: Size, crop: CropRect, zoom: number): Framing {
  return { cx: (crop.x + crop.side / 2) / size.width, cy: (crop.y + crop.side / 2) / size.height, zoom };
}

/**
 * Перетаскивание: картинка едет за пальцем, значит квадрат — навстречу.
 * Сдвиг — в точках превью стороной `previewSide`.
 */
export function panBy(size: Size, framing: Framing, minSide: number, dx: number, dy: number, previewSide: number): Framing {
  const crop = cropOf(size, framing, minSide);
  const scale = crop.side / previewSide;
  const moved = { ...crop, x: clamp(crop.x - dx * scale, 0, size.width - crop.side), y: clamp(crop.y - dy * scale, 0, size.height - crop.side) };
  return framingOf(size, moved, clamp(framing.zoom, 1, maxZoom(size, minSide)));
}

/** Приближение вокруг того же центра; у края центр сдвигается, чтобы квадрат остался внутри. */
export function zoomTo(size: Size, framing: Framing, minSide: number, zoom: number): Framing {
  const clamped = clamp(zoom, 1, maxZoom(size, minSide));
  return framingOf(size, cropOf(size, { ...framing, zoom: clamped }, minSide), clamped);
}

/** Сторона результата: не больше профиля и не больше того, что есть в исходнике, — растягивать мелкое незачем. */
export function outputSide(crop: CropRect, profileSide: number): number {
  return Math.max(1, Math.round(Math.min(profileSide, crop.side)));
}

export type Encoded = { ok: true; blob: Blob; quality: number } | { ok: false; problem: string };

/**
 * Сжать в WebP не тяжелее предела: качество шагами вниз. Браузер, который не
 * умеет WebP, молча отдаёт PNG — это ловится по типу, а не на сервере.
 */
export async function encodeWithin(encode: (quality: number) => Promise<Blob | null>, maxBytes: number): Promise<Encoded> {
  for (const quality of QUALITY_STEPS) {
    const blob = await encode(quality);
    if (blob === null) return { ok: false, problem: "Браузер не смог сжать картинку — попробуйте другой файл" };
    if (blob.type !== "image/webp") return { ok: false, problem: "Этот браузер не сохраняет WebP — откройте панель в Chrome, Edge или Firefox" };
    if (blob.size <= maxBytes) return { ok: true, blob, quality };
  }
  return { ok: false, problem: `Даже сильно сжатая картинка тяжелее ${String(Math.round(maxBytes / 1024))} КБ — возьмите попроще` };
}
