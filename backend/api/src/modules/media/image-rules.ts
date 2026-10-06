import { createHash } from "node:crypto";
import type { Permission } from "../roles/permissions.js";

/**
 * Картинки из панели (docs/35-stage4-plan.md О42, Р82): лежат в базе до CDN,
 * адрес — по хэшу содержимого, поэтому кешируются навсегда и при переезде на
 * CDN не меняются.
 *
 * Сервер картинку не перекодирует: сжимает и обрезает панель, а здесь —
 * проверка того, что пришло: сигнатура WebP, размер, стороны по профилю.
 * Анимацию и метаданные не принимаем — анимация отвлекает в строке задания, а
 * в EXIF бывает геометка того, кто снимал.
 */

/** Потолок файла: строке задания хватает десятков килобайт, слайду главной — сотни. */
export const IMAGE_MAX_BYTES = 200 * 1024;

export const IMAGE_CONTENT_TYPE = "image/webp";

export interface ImageProfile {
  /** чем картинка будет у игрока — словами для ошибки */
  title: string;
  square: boolean;
  /** меньше — мыло на экранах с плотностью 3 */
  minSide: number;
  maxSide: number;
  /** кто вправе загрузить — тот же, кто правит то, к чему картинка */
  permission: Permission;
}

/**
 * Профили картинок. Квадрат задания показывается в 44 px, на плотности 3 —
 * 132 точки: 96 ещё терпимо, а больше 512 — лишний вес без пользы глазу.
 * Квадрат слайда главной — 56 px, на плотности 3 — 168 точек.
 */
export const IMAGE_PROFILES = {
  task: { title: "картинка задания", square: true, minSide: 96, maxSide: 512, permission: "tasks.edit" },
  home_slide: { title: "картинка слайда главной", square: true, minSide: 112, maxSide: 512, permission: "home.edit" },
} as const satisfies Record<string, ImageProfile>;

export type ImageProfileId = keyof typeof IMAGE_PROFILES;

export const IMAGE_PROFILE_IDS = Object.keys(IMAGE_PROFILES) as [ImageProfileId, ...ImageProfileId[]];

/** id картинки — SHA-256 содержимого в hex: одинаковый файл — одна строка и один адрес. */
export const IMAGE_ID = /^[0-9a-f]{64}$/;

/** Имя файла в адресе: `<id>.webp`. */
export const IMAGE_FILE = /^([0-9a-f]{64})\.webp$/;

export function imageIdOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Адрес картинки у игрока — относительный: клиент знает свой адрес API. */
export function imagePath(imageId: string): string {
  return `/api/v1/media/${imageId}.webp`;
}

export interface WebpInfo {
  width: number;
  height: number;
  animated: boolean;
  /** EXIF или XMP */
  metadata: boolean;
}

/**
 * Заголовок WebP (RIFF): размеры из первого блока — `VP8X` (расширенный: его
 * отдаёт кодировщик Chromium), `VP8 ` (с потерями) или `VP8L` (без потерь).
 * Не WebP, обрезанный файл или длина RIFF, не совпавшая с файлом, — `null`.
 */
export function inspectWebp(bytes: Uint8Array): WebpInfo | null {
  if (bytes.length < 30) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number): string => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WEBP") return null;
  if (view.getUint32(4, true) + 8 !== bytes.length) return null;
  const uint24 = (offset: number): number => view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);

  const chunk = tag(12);
  if (chunk === "VP8X") {
    const flags = view.getUint8(20);
    // Флаги VP8X: 0x02 — анимация, 0x04 — XMP, 0x08 — EXIF.
    return { width: uint24(24) + 1, height: uint24(27) + 1, animated: (flags & 0x02) !== 0, metadata: (flags & 0x0c) !== 0 };
  }
  if (chunk === "VP8 ") {
    // Ключевой кадр: нулевой младший бит тега кадра и стартовый код 9d 01 2a.
    if ((view.getUint8(20) & 0x01) !== 0 || view.getUint8(23) !== 0x9d || view.getUint8(24) !== 0x01 || view.getUint8(25) !== 0x2a) return null;
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff, animated: false, metadata: false };
  }
  if (chunk === "VP8L") {
    if (view.getUint8(20) !== 0x2f) return null;
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, animated: false, metadata: false };
  }
  return null;
}

export type ImageCheck = { ok: true; width: number; height: number } | { ok: false; problem: string };

/** Подходит ли файл профилю; отказ — словами для панели. */
export function checkImage(bytes: Uint8Array, profile: ImageProfile): ImageCheck {
  if (bytes.length > IMAGE_MAX_BYTES) return { ok: false, problem: `Файл больше ${String(IMAGE_MAX_BYTES / 1024)} КБ` };
  const info = inspectWebp(bytes);
  if (info === null) return { ok: false, problem: "Это не WebP или файл повреждён" };
  if (info.animated) return { ok: false, problem: "Анимированные картинки не принимаем" };
  if (info.metadata) return { ok: false, problem: "В картинке есть метаданные (EXIF или XMP) — сохраните её из панели заново" };
  return fitsProfile(info, profile) ?? { ok: true, width: info.width, height: info.height };
}

/** Стороны под профиль: `null` — подходят. Им же проверяется уже сохранённая картинка. */
export function fitsProfile(size: { width: number; height: number }, profile: ImageProfile): { ok: false; problem: string } | null {
  if (profile.square && size.width !== size.height) return { ok: false, problem: `${capitalize(profile.title)} — квадрат, а пришло ${String(size.width)}×${String(size.height)}` };
  const side = Math.min(size.width, size.height);
  if (side < profile.minSide) return { ok: false, problem: `${capitalize(profile.title)} — не меньше ${String(profile.minSide)} px по стороне` };
  if (Math.max(size.width, size.height) > profile.maxSide) return { ok: false, problem: `${capitalize(profile.title)} — не больше ${String(profile.maxSide)} px по стороне` };
  return null;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
