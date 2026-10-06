import { z } from "zod";
import type { StoredImage } from "./media.repository.js";

/** Ровно то, что нужно от ответа Fastify для отдачи картинки, — без его типов. */
export interface ImageReply {
  status(code: number): ImageReply;
  header(name: string, value: string): ImageReply;
  send(payload?: Uint8Array): unknown;
}

const headersSchema = z.object({ headers: z.object({ "if-none-match": z.string().max(256).optional().catch(undefined) }).catch({}) }).catch({ headers: {} });

/**
 * Отдать картинку. Адрес — хэш содержимого, поэтому кеш вечный и
 * неизменяемый: браузер и CDN не спрашивают её второй раз. Повторный вопрос с
 * тем же ETag — 304 без тела.
 */
export function sendImage(reply: ImageReply, image: StoredImage, request: unknown): void {
  const etag = `"${image.imageId}"`;
  reply
    .header("cache-control", "public, max-age=31536000, immutable")
    .header("etag", etag)
    // Картинка не превращается в страницу, даже если браузер решит угадать тип.
    .header("x-content-type-options", "nosniff");
  const asked = headersSchema.parse(request).headers["if-none-match"];
  if (asked !== undefined && asked.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag)) {
    reply.status(304).send();
    return;
  }
  reply.status(200).header("content-type", image.contentType).send(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength));
}
