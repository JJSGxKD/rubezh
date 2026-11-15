import type { AdminApi } from "../api/client";
import { IMAGE_MAX_BYTES, IMAGE_PROFILES, uploadImage } from "../api/media";
import { fetchSourceAvatar, missOf, SOURCE_MESSAGES, type SourceRequest } from "../api/source-avatar";
import { partnerPlatforms, type TaskDef } from "../api/tasks";
import { CENTERED, cropOf, encodeWithin, outputSide, sizeProblem } from "./image-crop";

/**
 * Картинка задания с источника (docs/35-stage4-plan.md Р158): у подписки на
 * канал, запуска бота и Mini App картинка — аватарка источника. Сервер отдаёт
 * её байтами как есть; панель кадрирует по центру, сжимает в WebP тем же
 * `encodeWithin` и загружает обычной загрузкой профиля `task`, без окна
 * кадрирования.
 *
 * Правила — чистые функции без DOM: что считать источником и когда брать
 * картинку сама. DOM нужен только `browserPipeline`, и тесты подменяют его.
 */

/** Ввод затих — тогда и спрашиваем: запрос на каждую набранную букву сжёг бы лимит сервера. */
export const SOURCE_DEBOUNCE_MS = 800;

export type SourceKind = "channel" | "bot";

export type SourceReading =
  /** у вида источника нет: ссылка, забеги и остальное */
  | { state: "none" }
  /** источник ещё набирают: имя или ссылка не прошли проверку формы */
  | { state: "incomplete"; kind: SourceKind }
  /** площадка картинку не отдаёт (MAX, VK): загрузить придётся руками */
  | { state: "unsupported"; kind: SourceKind }
  | { state: "ready"; kind: SourceKind; request: SourceRequest; key: string };

const CHANNEL_NAME = /^@[A-Za-z][A-Za-z0-9_]{3,31}$/;
const CHANNEL_ID = /^-?\d{1,20}$/;
const BOT_NAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const APP_NAME = /^[A-Za-z][A-Za-z0-9_]{1,31}$/;

/** Ссылка на бота или Mini App: https и путь `/<имя>` или `/<имя>/<приложение>`; домен проверяет сервер — он знает настройку. */
function botLinkKey(url: string): string | null {
  const text = url.trim();
  if (!URL.canParse(text)) return null;
  const parsed = new URL(text);
  if (parsed.protocol !== "https:") return null;
  const segments = parsed.pathname.split("/").slice(1);
  if (segments.at(-1) === "") segments.pop();
  const [bot, app] = segments;
  if (bot === undefined || segments.length > 2 || !BOT_NAME.test(bot) || (app !== undefined && !APP_NAME.test(app))) return null;
  return `${parsed.hostname}/${segments.join("/")}`;
}

/** Что у задания источником: канал или бот, готов ли он к запросу и откуда его ключ. */
export function readSource(task: Pick<TaskDef, "kind" | "params">): SourceReading {
  const params = task.params;
  if (task.kind === "channel") {
    if (params?.platform !== undefined && params.platform !== "telegram") return { state: "unsupported", kind: "channel" };
    const chat = params?.chat?.trim() ?? "";
    if (params?.platform === undefined || !(CHANNEL_NAME.test(chat) || CHANNEL_ID.test(chat))) return { state: "incomplete", kind: "channel" };
    return { state: "ready", kind: "channel", request: { kind: "channel", platform: "telegram", chat }, key: `channel:telegram:${chat.toLowerCase()}` };
  }
  if (task.kind === "bot") {
    // Площадки не выбраны — задание видно везде, в том числе в Telegram.
    const platforms = partnerPlatforms(params);
    if (platforms.length > 0 && !platforms.includes("telegram")) return { state: "unsupported", kind: "bot" };
    const url = params?.url.trim() ?? "";
    const key = botLinkKey(url);
    if (key === null) return { state: "incomplete", kind: "bot" };
    return { state: "ready", kind: "bot", request: { kind: "bot", platform: "telegram", url }, key: `bot:telegram:${key.toLowerCase()}` };
  }
  return { state: "none" };
}

export interface TakeContext {
  reading: SourceReading;
  /** что сейчас в поле: `null` — пусто */
  image: string | null;
  /** картинка, которую панель взяла сама в этой форме, и источник, с которого */
  taken: { imageId: string; key: string } | null;
  /** оператор нажал «Убрать»: сама больше не подставляется, пока не нажмут «Обновить с источника» */
  removedByHand: boolean;
  /** источник, который уже пробовали: не повторяем, пока он не сменился */
  attemptedKey: string | null;
}

/**
 * Брать ли картинку сама. Пустое поле и готовый источник — да. Своя
 * загруженная не трогается никогда; взятая панелью заменяется, только когда
 * источник сменили (поправили имя канала), — это не «своя», а подсказка.
 */
export function shouldTakeFromSource(context: TakeContext): boolean {
  const { reading, image, taken, removedByHand, attemptedKey } = context;
  if (reading.state !== "ready" || removedByHand || attemptedKey === reading.key) return false;
  if (image === null) return true;
  return taken !== null && image === taken.imageId;
}

export type Taken = { ok: true; imageId: string } | { ok: false; outcome: "none" | "failed"; message: string };

/** Байты источника → WebP по правилам профиля. */
export interface ImagePipeline {
  toWebp(blob: Blob): Promise<{ ok: true; blob: Blob } | { ok: false; problem: string; outcome: "none" | "failed" }>;
}

/** Кадр по центру, сторона и сжатие — как у кадрирования вручную, только без окна. */
export const browserPipeline: ImagePipeline = {
  async toWebp(blob) {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      return { ok: false, outcome: "none", problem: "Картинку источника не удалось открыть — загрузите свою" };
    }
    try {
      const { minSide, side: profileSide } = IMAGE_PROFILES.task;
      if (sizeProblem(bitmap, minSide) !== null) return { ok: false, outcome: "none", problem: "Картинка источника слишком мелкая — загрузите свою" };
      const crop = cropOf(bitmap, CENTERED, minSide);
      const side = outputSide(crop, profileSide);
      const canvas = document.createElement("canvas");
      canvas.width = side;
      canvas.height = side;
      const context = canvas.getContext("2d");
      if (context === null) return { ok: false, outcome: "failed", problem: "Браузер не смог сжать картинку — загрузите свою" };
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, crop.x, crop.y, crop.side, crop.side, 0, 0, side, side);
      const encoded = await encodeWithin((quality) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality)), IMAGE_MAX_BYTES);
      return encoded.ok ? { ok: true, blob: encoded.blob } : { ok: false, outcome: "failed", problem: encoded.problem };
    } finally {
      bitmap.close();
    }
  },
};

/** Взять аватарку источника и сохранить картинкой задания: скачать, кадрировать, сжать, загрузить. */
export async function takeSourceImage(api: AdminApi, request: SourceRequest, pipeline: ImagePipeline = browserPipeline): Promise<Taken> {
  const fetched = await fetchSourceAvatar(api, request);
  if (!fetched.ok) return { ok: false, ...missOf(fetched.error) };
  const webp = await pipeline.toWebp(fetched.data.blob);
  if (!webp.ok) return { ok: false, outcome: webp.outcome, message: webp.problem };
  const uploaded = await uploadImage(api, "task", webp.blob);
  if (!uploaded.ok) return { ok: false, outcome: "failed", message: uploaded.error.message };
  return { ok: true, imageId: uploaded.data.imageId };
}

export interface RefillSummary {
  updated: number;
  missed: number;
  text: string;
}

export interface RefillSteps {
  take(request: SourceRequest): Promise<Taken>;
  /** сохранить задание тем же сохранением, что форма; `false` — не сохранилось */
  save(task: TaskDef): Promise<boolean>;
}

/**
 * «Картинки источников» над списком заданий: активные `channel` и `bot` без
 * картинки — по одному, не параллельно, чтобы не упереться в лимит сервера и
 * не плодить запросы к площадке.
 */
export async function refillSourceImages(tasks: readonly TaskDef[], steps: RefillSteps): Promise<RefillSummary> {
  let updated = 0;
  let missed = 0;
  for (const task of tasks) {
    if (!task.active || task.image !== null) continue;
    const reading = readSource(task);
    if (reading.state !== "ready") continue;
    const taken = await steps.take(reading.request);
    if (taken.ok && (await steps.save({ ...task, image: taken.imageId }))) updated += 1;
    else missed += 1;
  }
  return { updated, missed, text: `Обновлено ${String(updated)}, без картинки ${String(missed)}` };
}

export { SOURCE_MESSAGES };
