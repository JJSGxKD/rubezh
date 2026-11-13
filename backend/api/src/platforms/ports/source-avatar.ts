import type { PlatformId } from "./platform.js";

/**
 * Картинка источника партнёрского задания (docs/35-stage4-plan.md Р158):
 * аватарка канала, бота или Mini App, на который ведёт задание. Как площадка
 * отдаёт аватарку, знает только её адаптер; домен получает байты и ошибки
 * порта. Сервер картинку не перекодирует — квадрат и WebP делает панель
 * (Р82), поэтому адаптер отдаёт файл как есть.
 */

/** Что площадка отдаёт аватаркой: по сигнатуре байтов, а не по заголовку ответа. */
export const SOURCE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type SourceImageType = (typeof SOURCE_IMAGE_TYPES)[number];

/** Не больше, чем нужно, чтобы кадрировать до 512 px: чужой файл читается с потолком. */
export const SOURCE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

export interface SourceImage {
  bytes: Uint8Array;
  contentType: SourceImageType;
}

/** Откуда берётся картинка: канал или чат в записи площадки либо ссылка на бота или Mini App. */
export type SourceRef = { kind: "channel"; chat: string } | { kind: "bot"; url: string };

/** Площадка не ответила — повтор может помочь. */
export class SourceAvatarUnavailableError extends Error {
  override readonly name = "SourceAvatarUnavailableError";
}

/** Источник не разобран: это не канал и не ссылка на бота или Mini App этой площадки. */
export class SourceAvatarRejectedError extends Error {
  override readonly name = "SourceAvatarRejectedError";
}

export interface SourceAvatar {
  readonly platform: PlatformId;
  /**
   * @returns картинка или `null` — у источника её нет (или адрес ведёт не туда,
   * куда адаптеру разрешено ходить)
   * @throws SourceAvatarRejectedError источник не разобран
   * @throws SourceAvatarUnavailableError площадка не ответила
   */
  fetch(source: SourceRef, signal: AbortSignal): Promise<SourceImage | null>;
}

/** Адаптеры всех площадок: домен выбирает по площадке задания. */
export class SourceAvatars {
  private readonly all: SourceAvatar[];

  constructor(all: readonly SourceAvatar[]) {
    this.all = [...all];
  }

  /** Адаптер площадки подключает себя сам; повтор заменяет адаптер той же площадки. */
  register(avatar: SourceAvatar): void {
    const index = this.all.findIndex((item) => item.platform === avatar.platform);
    if (index === -1) this.all.push(avatar);
    else this.all[index] = avatar;
  }

  /** `null` — площадка картинку не отдаёт (у MAX и VK адаптера нет). */
  for(platform: PlatformId): SourceAvatar | null {
    return this.all.find((avatar) => avatar.platform === platform) ?? null;
  }
}

/**
 * Прочитать тело ответа не дальше `maxBytes`. Заявленная длина больше предела
 * — тело не читается вовсе; заявленной нет или она врёт — чтение обрывается на
 * пределе. `null` — тело больше предела: чужой файл не копится в памяти.
 */
export async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
