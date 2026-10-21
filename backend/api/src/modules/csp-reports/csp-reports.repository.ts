import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../../infra/redis.js";
import type { CspHit } from "./csp-report-parse.js";

/**
 * Сводка отчётов политики источников в Redis (Р108, tasks/T-0155): без
 * миграции, ограничена по числу ключей и сама устаревает. Каждая команда идёт
 * с таймаутом клиента (`infra/redis.ts`).
 *
 * Три ключа: `csp:count` и `csp:last` — хеши с полем `<директива>|<хост>`
 * (счёт и момент последнего, мс), `csp:overflow` — сколько отчётов не поместилось.
 * Кроме директивы, хоста, счёта и момента в Redis ничего не попадает.
 */

/**
 * Сколько разных пар «директива, хост» хранит сводка. Хостов в блокировках
 * на деле десятки; потолок нужен потому, что приёмник открыт без входа, и
 * без него кто угодно раздул бы ключ случайными именами.
 */
export const MAX_ENTRIES = 200;

/**
 * Сводка устаревает за 30 суток после последней записи: список разрешённых
 * адресов дополняют по свежим отчётам, а давно не повторявшаяся блокировка
 * уже никому не мешает. Кнопки сброса нет сознательно.
 */
export const SUMMARY_TTL_SEC = 30 * 24 * 3600;

const COUNT_KEY = "csp:count";
const LAST_KEY = "csp:last";
const OVERFLOW_KEY = "csp:overflow";

export interface CspStoredEntry {
  directive: string;
  host: string;
  count: number;
  /** момент последнего отчёта, мс */
  lastAtMs: number;
}

export interface CspReportsRepository {
  record(hit: CspHit, nowMs: number): Promise<void>;
  read(): Promise<{ entries: CspStoredEntry[]; overflow: number }>;
}

export const CSP_REPORTS_REPOSITORY = Symbol("CSP_REPORTS_REPOSITORY");

/**
 * Запись одним скриптом: проверка потолка и вставка нового поля должны быть
 * неделимы, иначе два отчёта в одну миллисекунду оба увидят свободное место и
 * пробьют потолок. Переполнение тоже получает срок жизни: его ключ мог бы
 * пережить сводку, если после заполнения новые пары приходят, а старые нет.
 * Момент в `csp:last` не отступает назад: отчёты разных реплик могут прийти не по порядку.
 * KEYS: count, last, overflow; ARGV: поле, момент (мс), потолок, срок (с).
 */
const RECORD_SCRIPT = `
local exists = redis.call("HEXISTS", KEYS[1], ARGV[1])
if exists == 0 and redis.call("HLEN", KEYS[1]) >= tonumber(ARGV[3]) then
  redis.call("INCR", KEYS[3])
  redis.call("EXPIRE", KEYS[3], ARGV[4])
  return 0
end
redis.call("HINCRBY", KEYS[1], ARGV[1], 1)
local last = tonumber(redis.call("HGET", KEYS[2], ARGV[1]))
if last == nil or tonumber(ARGV[2]) >= last then
  redis.call("HSET", KEYS[2], ARGV[1], ARGV[2])
end
redis.call("EXPIRE", KEYS[1], ARGV[4])
redis.call("EXPIRE", KEYS[2], ARGV[4])
if redis.call("EXISTS", KEYS[3]) == 1 then
  redis.call("EXPIRE", KEYS[3], ARGV[4])
end
return 1
`;

function toInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

@Injectable()
export class RedisCspReportsRepository implements CspReportsRepository {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async record(hit: CspHit, nowMs: number): Promise<void> {
    await this.redis.eval(RECORD_SCRIPT, 3, COUNT_KEY, LAST_KEY, OVERFLOW_KEY, `${hit.directive}|${hit.host}`, String(nowMs), String(MAX_ENTRIES), String(SUMMARY_TTL_SEC));
  }

  async read(): Promise<{ entries: CspStoredEntry[]; overflow: number }> {
    const [counts, lasts, overflow] = await Promise.all([this.redis.hgetall(COUNT_KEY), this.redis.hgetall(LAST_KEY), this.redis.get(OVERFLOW_KEY)]);
    const entries: CspStoredEntry[] = [];
    for (const [field, rawCount] of Object.entries(counts)) {
      const separator = field.indexOf("|");
      const count = toInt(rawCount);
      const lastAtMs = toInt(lasts[field]);
      // Поле без пары или битое значение — следы сбоя: сводка их не показывает.
      if (separator <= 0 || count === null || lastAtMs === null) continue;
      entries.push({ directive: field.slice(0, separator), host: field.slice(separator + 1), count, lastAtMs });
    }
    return { entries, overflow: toInt(overflow ?? undefined) ?? 0 };
  }
}
