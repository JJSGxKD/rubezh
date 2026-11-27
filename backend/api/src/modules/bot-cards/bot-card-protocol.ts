import { createHash, randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { z } from "zod";
import { withTimeout } from "../../common/with-timeout.js";
import type { PlatformId } from "../../platforms/ports/platform.js";

/**
 * Протокол живой карточки (docs/35-stage4-plan.md Р199, tasks/T-0395): запрос
 * из карточки, состояние и ответ, имена заданий и ключи Redis. Разбор и сборка —
 * чистые функции без Nest и базы: данные из карточки приходят от клиента, поэтому
 * разбор строг и проверяется тестом без окружения. Лок Redis — общий для сервиса,
 * правок и финализатора, поэтому живёт здесь же.
 */

/** Версия протокола: состояние и ответ всегда несут `v: 1`. */
export const CARD_STATE_VERSION = 1;

/** Предел `callback_data` у Telegram, байт: данные запроса не длиннее. */
export const MAX_QUERY_BYTES = 64;

/** Предел состояния и ответа, байт: им делится вид карточки с адаптером площадки. */
export const MAX_STATE_BYTES = 1024;

/** Вид карточки: латиница строчными и подчёркивание — по нему адаптер выбирает облик. */
export const CARD_KIND_PATTERN = /^[a-z_]{3,16}$/;

/** Действие «обновить»: есть у каждого вида, в `actions` вида не входит. */
export const REFRESH_ACTION = "r";

/**
 * Флаги состояния, которые понимает уже первая версия карточки. Ключи в JSON — значения; `closed` пишется
 * коротко (`x`): состояние ограничено 1024 байтами, и флаг, который ставят всем закрытым карточкам, не должен их есть.
 */
export const CARD_FLAGS = { moved: "moved", off: "off", stale: "stale", closed: "x" } as const;

const QUERY_PATTERN = /^v(\d{1,2}):([a-z_]{1,24})(?::([A-Za-z0-9_-]{1,32}))?$/;

export interface ParsedQuery {
  version: number;
  action: string;
  arg: string | null;
}

/** `v<версия>:<действие>[:<аргумент>]` — всё остальное, в том числе длиннее 64 байт, мусор. */
export function parseQueryData(data: string): ParsedQuery | null {
  if (Buffer.byteLength(data, "utf8") > MAX_QUERY_BYTES) return null;
  const match = QUERY_PATTERN.exec(data);
  if (match === null) return null;
  return { version: Number(match[1]), action: match[2] ?? "", arg: match[3] ?? null };
}

/** JSON с `v: 1` первым полем: чужое `v` в объекте вида не переживёт. */
function withVersion(object: Record<string, unknown>): string {
  const rest = Object.fromEntries(Object.entries(object).filter(([key]) => key !== "v"));
  return JSON.stringify({ v: CARD_STATE_VERSION, ...rest });
}

/**
 * Состояние карточки строкой. Длиннее предела — `RangeError`: вид обязан держаться в 1024 байтах,
 * а обрезанный JSON площадка не разберёт — молчаливо обрезать нельзя.
 */
export function encodeState(state: Record<string, unknown>): string {
  const json = withVersion(state);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_STATE_BYTES) throw new RangeError(`Состояние карточки ${String(bytes)} байт, предел ${String(MAX_STATE_BYTES)}`);
  return json;
}

export function stateHash(json: string): string {
  return createHash("sha256").update(json, "utf8").digest("hex");
}

const BIG_ANSWER = '{"v":1,"err":"big"}';

/**
 * Ответ на запрос — строка не длиннее 1024 байт. Длиннее — `{"v":1,"err":"big"}`: ответ обязан уйти
 * всегда, а о разросшемся состоянии скажет `onTooBig` (строка лога), а не площадка.
 */
export function answerOf(object: Record<string, unknown>, onTooBig?: () => void): string {
  const json = withVersion(object);
  if (Buffer.byteLength(json, "utf8") <= MAX_STATE_BYTES) return json;
  onTooBig?.();
  return BIG_ANSWER;
}

const stateSchema = z.record(z.string(), z.unknown());

/** Сохранённое состояние обратно в объект; `null` — строка не разобралась (в таблицу её кладёт сам сервис, но JSON из БД — граница). */
export function parseState(json: string): Record<string, unknown> | null {
  try {
    const parsed = stateSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Имена заданий карточек в очереди `notifications-bot`. */
export const CARD_JOBS = { send: "card-send", edit: "card-edit", moved: "card-moved", final: "card-final" } as const;

/**
 * Идентификатор задания из частей через дефис. BullMQ отклоняет `:` в идентификаторе (кроме ровно двух
 * двоеточий), поэтому части очищаются: всё, кроме букв, цифр, `_` и `-`, — подчёркивание, пустая часть — `none`.
 */
export function pacedJobId(name: string, ...parts: readonly string[]): string {
  return [name, ...parts.map((part) => (part === "" ? "none" : part.replace(/[^A-Za-z0-9_-]/g, "_")))].join("-");
}

/** Лок отправки: две отправки одной карточки одному игроку не идут разом. */
export const sendLockKey = (accountId: string, kind: string): string => `bot-cards:send:${accountId}:${kind}`;
/** Лок прохода финализатора. */
export const FINAL_LOCK_KEY = "bot-cards:final:lock";
/** Пауза карточек площадки после отказа (Р225): общая для реплик. */
export const pausedKey = (platform: PlatformId): string => `bot-cards:paused:${platform}`;
/** Лок одной карточки: правка, перенос и финал не затирают друг друга. */
export const cardLockKey = (cardId: string): string => `bot-cards:card:${cardId}`;
/** Кэш состояния для запросов «обновить»: одно состояние на аккаунт и вид. */
export const stateCacheKey = (accountId: string, kind: string): string => `bot-card:state:${accountId}:${kind}`;

/**
 * Вызов карточки (сборка состояния, площадка) не ответил за срок. Лок карточки после такого отказа не
 * снимается: брошенный вызов может ещё доработать, и вторая операция не должна пойти поверх него — лок
 * истечёт сам (tasks/T-0395, «доработка»).
 */
export class CardCallTimeout extends Error {}

/** Как `withTimeout`, но отказ помечен `CardCallTimeout`: по нему вызывающий оставляет лок до истечения срока. */
export async function withCardTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new CardCallTimeout(`${label}: нет ответа за ${ms} мс`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const LOCK_TIMEOUT_MS = 3_000;

/** Снимает лок только тот, кто его взял: операция, пережившая свой лок, чужой не снимет. */
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

/**
 * Лок `SET NX PX` с токеном. `null` — занят. Сбой Redis летит наружу: что делать без лока —
 * решает вызывающий (отправка идёт дальше и полагается на индекс таблицы, правка уступает).
 */
export async function acquireLock(redis: Pick<Redis, "set">, key: string, ttlMs: number): Promise<string | null> {
  const token = randomUUID();
  const taken = await withTimeout(redis.set(key, token, "PX", ttlMs, "NX"), LOCK_TIMEOUT_MS, "лок карточек бота");
  return taken === "OK" ? token : null;
}

export async function releaseLock(redis: Pick<Redis, "eval">, key: string, token: string): Promise<void> {
  await withTimeout(redis.eval(RELEASE_SCRIPT, 1, key, token), LOCK_TIMEOUT_MS, "снятие лока карточек бота");
}

/** Данные задания — граница (Redis): разбираются схемой, а не приводятся. */
const id = z.string().uuid();
const kindId = z.string().regex(CARD_KIND_PATTERN);

export const sendJobSchema = z.object({ accountId: id, kind: kindId, origin: z.enum(["reply", "player", "bot"]) });
export const cardJobSchema = z.object({ cardId: id });
export const finalJobSchema = z.object({
  cardId: id,
  state: z.string().refine((state) => Buffer.byteLength(state, "utf8") <= MAX_STATE_BYTES, { message: "состояние длиннее предела" }),
});
