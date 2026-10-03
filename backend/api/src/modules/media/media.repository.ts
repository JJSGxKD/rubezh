import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * Картинки в базе (`media_image`, docs/35-stage4-plan.md О42). Строка не
 * меняется никогда: id — хэш содержимого, повтор того же файла — та же строка.
 */

export interface ImageMeta {
  imageId: string;
  width: number;
  height: number;
  sizeBytes: number;
}

export interface StoredImage extends ImageMeta {
  contentType: string;
  data: Uint8Array;
}

export interface NewImage extends StoredImage {
  createdBy: string;
}

export const MEDIA_REPOSITORY = Symbol("MEDIA_REPOSITORY");

export interface MediaRepository {
  /** Сохранить; такая уже есть — вернуть её, вторую не заводить. */
  insert(image: NewImage): Promise<ImageMeta>;
  byId(imageId: string): Promise<StoredImage | null>;
  meta(imageId: string): Promise<ImageMeta | null>;
}

const META = { imageId: true, width: true, height: true, sizeBytes: true } as const;

@Injectable()
export class PrismaMediaRepository implements MediaRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async insert(image: NewImage): Promise<ImageMeta> {
    await this.prisma.mediaImage.createMany({ data: [{ ...image, data: Uint8Array.from(image.data) }], skipDuplicates: true });
    return await this.prisma.mediaImage.findUniqueOrThrow({ where: { imageId: image.imageId }, select: META });
  }

  async byId(imageId: string): Promise<StoredImage | null> {
    return await this.prisma.mediaImage.findUnique({ where: { imageId }, select: { ...META, contentType: true, data: true } });
  }

  async meta(imageId: string): Promise<ImageMeta | null> {
    return await this.prisma.mediaImage.findUnique({ where: { imageId }, select: META });
  }
}
