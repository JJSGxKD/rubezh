import type { Redis } from "ioredis";
import { z } from "zod";
import { withTimeout } from "../../common/with-timeout.js";

/**
 * Состояние перечистки ников из панели (docs/35-stage4-plan.md, Р168,
 * tasks/T-0339): что делает последнее задание и чем кончилось. Хранится одной
 * записью в Redis — задание на сервере одно, история лежит в журнале аудита.
 * Читается только через `readRecleanState`: битое значение — «состояния нет».
 */

/** JSON состояния, срок — неделя: итог прошлой перечистки виден, пока его не заменили. */
export const RECLEAN_STATE_KEY = "name-rules:reclean:state";
export const RECLEAN_STATE_TTL_SEC = 7 * 86_400;
/** Замок на весь сервер; продлевается на каждой пачке, поэтому упавший процесс отпускает его сам. */
export const RECLEAN_LOCK_KEY = "name-rules:reclean:lock";
export const RECLEAN_LOCK_TTL_MS = 120_000;
/** Флаг «остановить»: проход смотрит на него перед каждой пачкой. */
export const RECLEAN_STOP_KEY = "name-rules:reclean:stop";
export const RECLEAN_STOP_TTL_SEC = 3_600;
/** Предпросмотр годен час: за это время правила и ники успевают уйти слишком далеко. */
export const RECLEAN_PREVIEW_TTL_MS = 3_600_000;
/** Пауза между пачками — чтобы запись не вытесняла игровой трафик. */
export const RECLEAN_PAGE_PAUSE_MS = 100;

const REDIS_TIMEOUT_MS = 2_000;

export type RecleanMode = "preview" | "run";
export type RecleanStatus = "queued" | "running" | "done" | "failed" | "stopped";

export interface RecleanState {
  runId: string;
  mode: RecleanMode;
  status: RecleanStatus;
  /** подпись набора правил, по которому идёт проход */
  signature: string;
  scanned: number;
  planned: number;
  updated: number;
  skipped: number;
  locked: number;
  /** ISO UTC */
  startedAt: string;
  finishedAt: string | null;
  /** accountId того, кто запустил */
  startedBy: string;
  /** русский текст причины; шаблонов правил и ников в нём нет */
  error: string | null;
}

const count = z.number().int().nonnegative();

export const recleanStateSchema: z.ZodType<RecleanState> = z.strictObject({
  runId: z.string().min(1),
  mode: z.enum(["preview", "run"]),
  status: z.enum(["queued", "running", "done", "failed", "stopped"]),
  signature: z.string(),
  scanned: count,
  planned: count,
  updated: count,
  skipped: count,
  locked: count,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  startedBy: z.string(),
  error: z.string().nullable(),
});

export async function readRecleanState(redis: Pick<Redis, "get">): Promise<RecleanState | null> {
  const raw = await withTimeout(redis.get(RECLEAN_STATE_KEY), REDIS_TIMEOUT_MS, "перечистка: состояние");
  if (raw === null) return null;
  try {
    const parsed = recleanStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    // Битый JSON — то же, что отсутствие состояния: панель покажет «ещё не запускалась».
    return null;
  }
}

export async function writeRecleanState(redis: Pick<Redis, "set">, state: RecleanState): Promise<void> {
  await withTimeout(redis.set(RECLEAN_STATE_KEY, JSON.stringify(state), "EX", RECLEAN_STATE_TTL_SEC), REDIS_TIMEOUT_MS, "перечистка: запись состояния");
}
