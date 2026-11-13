import type { AdminApi, ApiError, ApiResult } from "./client";
import type { ChannelPlatform } from "./tasks";

/**
 * Картинка источника партнёрского задания (docs/35-stage4-plan.md Р158):
 * сервер отдаёт аватарку канала, бота или Mini App байтами как есть, а
 * кадрирует и сжимает панель (`ui/source-image.ts`).
 */

export const SOURCE_AVATAR_PATH = "/tasks/source-avatar";

/** Сервер ждёт площадку до 15 секунд, поэтому панель — чуть дольше. */
const SOURCE_AVATAR_TIMEOUT_MS = 20_000;

export type SourceRequest = { kind: "channel"; platform: ChannelPlatform; chat: string } | { kind: "bot"; platform: ChannelPlatform; url: string };

/** Состояния поля картинки словами сценария. */
export const SOURCE_MESSAGES = {
  loading: "Берём картинку…",
  none: "У источника нет картинки — загрузите свою",
  unsupported: "Эта площадка картинку не отдаёт — загрузите свою",
  failed: "Не удалось взять картинку",
  invalid: "Не удалось разобрать канал или ссылку — проверьте, что они верны",
} as const;

export function fetchSourceAvatar(api: AdminApi, source: SourceRequest): Promise<ApiResult<{ blob: Blob; fileName: string }>> {
  return api.download(SOURCE_AVATAR_PATH, source, SOURCE_AVATAR_TIMEOUT_MS);
}

/**
 * Чем кончилось: `none` — у источника картинки нет и повтор не поможет, `failed` —
 * сбой, и повтор имеет смысл.
 */
export type SourceMiss = { outcome: "none" | "failed"; message: string };

export function missOf(error: ApiError): SourceMiss {
  if (error.code === "source_avatar_missing") return { outcome: "none", message: SOURCE_MESSAGES.none };
  if (error.status === 422) return { outcome: "none", message: SOURCE_MESSAGES.invalid };
  if (error.kind === "rate_limited") return { outcome: "failed", message: error.message };
  return { outcome: "failed", message: SOURCE_MESSAGES.failed };
}
