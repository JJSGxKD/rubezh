import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { IMAGE_CONTENT_TYPE, IMAGE_PROFILES, checkImage, fitsProfile, imageIdOf, type ImageProfileId } from "./image-rules.js";
import { ImageNotFoundError, ImageRejectedError } from "./media-errors.js";
import { MEDIA_REPOSITORY, type ImageMeta, type MediaRepository, type StoredImage } from "./media.repository.js";

/**
 * Картинки из панели (docs/35-stage4-plan.md О42). Загружает команда —
 * правом того, к чему картинка; отдаются всем по хэшу содержимого.
 *
 * Строка картинки не меняется, поэтому реплика держит прочитанное в памяти без
 * сроков: устареть ему не от чего. Холодную картинку, которую разом
 * спрашивает сотня игроков, база читает однажды.
 */

const DB_TIMEOUT_MS = 3_000;

/** Сколько держит реплика: картинок немного, каждая — до 200 КБ. */
const CACHE_BUDGET_BYTES = 16 * 1024 * 1024;

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly cache = new ImageCache(CACHE_BUDGET_BYTES);
  private readonly reading = new Map<string, Promise<StoredImage | null>>();

  constructor(
    @Inject(MEDIA_REPOSITORY) private readonly repository: MediaRepository,
    private readonly roles: RolesService,
  ) {}

  async upload(actor: AccountRef, profileId: ImageProfileId, bytes: Uint8Array): Promise<ImageMeta> {
    await this.roles.require(actor, IMAGE_PROFILES[profileId].permission);
    const checked = checkImage(bytes, IMAGE_PROFILES[profileId]);
    if (!checked.ok) throw new ImageRejectedError(checked.problem);
    const imageId = imageIdOf(bytes);
    const meta = await this.db(
      this.repository.insert({ imageId, contentType: IMAGE_CONTENT_TYPE, width: checked.width, height: checked.height, sizeBytes: bytes.length, data: bytes, createdBy: actor.accountId }),
    );
    this.logger.log(JSON.stringify({ module: "media", event: "image_uploaded", accountId: actor.accountId, imageId, profile: profileId, sizeBytes: bytes.length }));
    return meta;
  }

  /** Уже в памяти — без базы; `undefined` — надо спрашивать (`read`). */
  peek(imageId: string): StoredImage | undefined {
    return this.cache.get(imageId);
  }

  /** Картинка для отдачи; нет такой — `null`. */
  async read(imageId: string): Promise<StoredImage | null> {
    const cached = this.cache.get(imageId);
    if (cached !== undefined) return cached;
    const inFlight = this.reading.get(imageId);
    if (inFlight !== undefined) return await inFlight;
    const loading = this.db(this.repository.byId(imageId)).finally(() => this.reading.delete(imageId));
    this.reading.set(imageId, loading);
    const image = await loading;
    if (image !== null) this.cache.set(image);
    return image;
  }

  /** Сохранённая картинка годится профилю — для того, что на неё ссылается: квадрат заданию, а не слайд. */
  async require(imageId: string, profileId: ImageProfileId): Promise<void> {
    const meta = await this.db(this.repository.meta(imageId));
    if (meta === null) throw new ImageNotFoundError();
    const misfit = fitsProfile(meta, IMAGE_PROFILES[profileId]);
    if (misfit !== null) throw new ImageRejectedError(misfit.problem);
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "media: база");
  }
}

/** Картинки в памяти по объёму: дольше всех не спрошенная уходит первой. */
export class ImageCache {
  private readonly items = new Map<string, StoredImage>();
  private bytes = 0;

  constructor(private readonly budgetBytes: number) {}

  get(imageId: string): StoredImage | undefined {
    const item = this.items.get(imageId);
    if (item === undefined) return undefined;
    // Map помнит порядок вставки: переставленная в конец — самая свежая.
    this.items.delete(imageId);
    this.items.set(imageId, item);
    return item;
  }

  set(image: StoredImage): void {
    if (this.items.has(image.imageId) || image.data.byteLength > this.budgetBytes) return;
    this.items.set(image.imageId, image);
    this.bytes += image.data.byteLength;
    for (const [imageId, oldest] of this.items) {
      if (this.bytes <= this.budgetBytes) break;
      this.items.delete(imageId);
      this.bytes -= oldest.data.byteLength;
    }
  }

  get size(): { count: number; bytes: number } {
    return { count: this.items.size, bytes: this.bytes };
  }
}
