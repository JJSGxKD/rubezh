import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { z } from "zod";
import { withTimeout } from "../../common/with-timeout.js";
import { REDIS } from "../../infra/redis.js";
import type { Difficulty } from "../runs/run-rules.js";
import { reminderWindowKey, type SnapshotEntry } from "./reminder-rules.js";

/**
 * Состояние планировщика напоминаний в Redis (tasks/T-0128): лок прохода,
 * снимок таблицы недели, курсоры страниц и метка суточного отчёта. Всё это
 * можно потерять без вреда: потерянный снимок — один пропущенный обгон,
 * курсор — повторный проход по тем же игрокам, который ключ события в ленте
 * сделает безвредным. Каждое обращение — с таймаутом.
 */

const TIMEOUT_MS = 3_000;
const LOCK_KEY = "reminders:scan:lock";
/** Проход укладывается в минуты, а интервал — десять: лок не должен пережить следующий проход. */
const LOCK_TTL_MS = 300_000;
/** Снимок живёт дольше недели: пропущенный проход не должен терять сравнение. */
const SNAPSHOT_TTL_SEC = 8 * 86_400;
const CURSOR_TTL_SEC = 2 * 86_400;
const REPORT_TTL_SEC = 3 * 86_400;

/** Метка курсора: страницы кончились, на сегодня больше нечего читать. */
export const CURSOR_DONE = "done";

/** Снимок из Redis — граница: разбирается схемой, а не приводится. */
const snapshotSchema = z.array(z.object({ accountId: z.string().min(1).max(64), rank: z.number().int().min(1), score: z.number().finite() }));

/** Снимает лок только тот, кто его взял: проход, переживший свой лок, чужой не снимет. */
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

@Injectable()
export class RemindersStore {
  constructor(@Inject(REDIS) private readonly redis: Pick<Redis, "set" | "get" | "del" | "eval" | "pipeline">) {}

  /** `SET NX PX` с токеном: лок держит одна реплика. */
  async acquireLock(token: string): Promise<boolean> {
    return (await withTimeout(this.redis.set(LOCK_KEY, token, "PX", LOCK_TTL_MS, "NX"), TIMEOUT_MS, "лок напоминаний")) === "OK";
  }

  async releaseLock(token: string): Promise<void> {
    await withTimeout(this.redis.eval(RELEASE_SCRIPT, 1, LOCK_KEY, token), TIMEOUT_MS, "снятие лока напоминаний");
  }

  /** `null` — снимка нет (первый проход сезона) или он не разобрался: сравнивать не с чем. */
  async readSnapshot(seasonKey: string, difficulty: Difficulty): Promise<SnapshotEntry[] | null> {
    const raw = await withTimeout(this.redis.get(snapshotKey(seasonKey, difficulty)), TIMEOUT_MS, "снимок таблицы недели");
    if (raw === null) return null;
    try {
      const parsed = snapshotSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      // Битый снимок равен отсутствующему: следующий проход запишет новый, а выдумывать обгон из мусора нельзя.
      return null;
    }
  }

  async writeSnapshot(seasonKey: string, difficulty: Difficulty, entries: readonly SnapshotEntry[]): Promise<void> {
    await withTimeout(this.redis.set(snapshotKey(seasonKey, difficulty), JSON.stringify(entries), "EX", SNAPSHOT_TTL_SEC), TIMEOUT_MS, "снимок таблицы недели");
  }

  /** Последний `account_id` страницы, `CURSOR_DONE` или `null` — начало. */
  async readCursor(name: string): Promise<string | null> {
    return await withTimeout(this.redis.get(`reminders:cur:${name}`), TIMEOUT_MS, "курсор напоминаний");
  }

  async writeCursor(name: string, value: string): Promise<void> {
    await withTimeout(this.redis.set(`reminders:cur:${name}`, value, "EX", CURSOR_TTL_SEC), TIMEOUT_MS, "курсор напоминаний");
  }

  /** У каких аккаунтов окно потолка занято — один конвейер на всю пачку. */
  async busyWindows(accountIds: readonly string[]): Promise<Set<string>> {
    const busy = new Set<string>();
    if (accountIds.length === 0) return busy;
    const pipeline = this.redis.pipeline();
    for (const accountId of accountIds) pipeline.exists(reminderWindowKey(accountId));
    const results = (await withTimeout(pipeline.exec(), TIMEOUT_MS, "окна потолка напоминаний")) ?? [];
    results.forEach(([error, exists], index) => {
      if (error !== null) throw error;
      const accountId = accountIds[index];
      if (accountId !== undefined && Number(exists) > 0) busy.add(accountId);
    });
    return busy;
  }

  /** Метка отчёта за игровые сутки `day`: `true` — отчёт за них ещё не брали. */
  async claimReport(day: string): Promise<boolean> {
    return (await withTimeout(this.redis.set(reportKey(day), "1", "EX", REPORT_TTL_SEC, "NX"), TIMEOUT_MS, "метка отчёта напоминаний")) === "OK";
  }

  async releaseReport(day: string): Promise<void> {
    await withTimeout(this.redis.del(reportKey(day)), TIMEOUT_MS, "метка отчёта напоминаний");
  }
}

function snapshotKey(seasonKey: string, difficulty: Difficulty): string {
  return `reminders:snap:${seasonKey}:${difficulty}`;
}

function reportKey(day: string): string {
  return `reminders:report:${day}`;
}
