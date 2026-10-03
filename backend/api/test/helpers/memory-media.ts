import type { ImageMeta, MediaRepository, NewImage, StoredImage } from "../../src/modules/media/media.repository.js";

/** Картинки в памяти: та же одна строка на файл, а чтение базы — с задержкой и счётом. */
export class MemoryMedia implements MediaRepository {
  readonly rows = new Map<string, StoredImage & { createdBy: string }>();
  reads = 0;

  async insert(image: NewImage): Promise<ImageMeta> {
    const row = this.rows.get(image.imageId) ?? { ...image, data: Uint8Array.from(image.data) };
    this.rows.set(image.imageId, row);
    return metaOf(row);
  }

  async byId(imageId: string): Promise<StoredImage | null> {
    this.reads += 1;
    // Ответ базы приходит не сразу: два чтения разом успевают встретиться.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return this.rows.get(imageId) ?? null;
  }

  async meta(imageId: string): Promise<ImageMeta | null> {
    const row = this.rows.get(imageId);
    return row === undefined ? null : metaOf(row);
  }
}

function metaOf(image: StoredImage): ImageMeta {
  return { imageId: image.imageId, width: image.width, height: image.height, sizeBytes: image.sizeBytes };
}
