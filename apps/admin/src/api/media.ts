import { z } from "zod";
import { ADMIN_API, type AdminApi, type ApiResult } from "./client";

/**
 * Картинки из панели (docs/35-stage4-plan.md О42): панель сама обрезает и
 * сжимает в WebP, сервер проверяет и кладёт в базу по хэшу содержимого.
 * Пределы — те же, что держит сервер (`media/image-rules.ts`).
 */

export const IMAGE_MAX_BYTES = 200 * 1024;

export type ImageProfileId = "task" | "home_slide";

export interface ImageProfile {
  /** сторона того, что уходит на сервер: запас к плотности экрана, без лишнего веса */
  side: number;
  /** меньше — сервер не примет, а игрок увидит мыло */
  minSide: number;
  /** где картинку увидит игрок и какого размера — словами для формы */
  shownAs: string;
}

/**
 * Квадрат задания у игрока — 44 px, слайда главной — 56 px; 256 — запас к
 * плотности 3 и к будущим крупным показам.
 */
export const IMAGE_PROFILES: Record<ImageProfileId, ImageProfile> = {
  task: { side: 256, minSide: 96, shownAs: "в строке задания — 44 px" },
  home_slide: { side: 256, minSide: 112, shownAs: "в слайде главной — 56 px" },
};

const imageSchema = z.object({ imageId: z.string(), width: z.number(), height: z.number(), sizeBytes: z.number() });
export type UploadedImage = z.infer<typeof imageSchema>;

/** Сохранённая картинка в панели — своим путём под сессией: наружу домен панели ходит только в `/api/v1/admin`. */
export function imageUrl(imageId: string): string {
  return `${ADMIN_API}/media/${encodeURIComponent(imageId)}.webp`;
}

/** Файл уходит base64 в JSON: так его разбирает та же схема, что всё остальное тело. */
export async function uploadImage(api: AdminApi, profile: ImageProfileId, blob: Blob): Promise<ApiResult<UploadedImage>> {
  return await api.request("/media/images", { method: "POST", body: { profile, data: await toBase64(blob) }, schema: imageSchema, timeoutMs: 30_000 });
}

export async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  // Кусками: String.fromCharCode с сотнями тысяч аргументов переполняет стек.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
