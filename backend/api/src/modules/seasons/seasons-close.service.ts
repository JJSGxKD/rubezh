import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { REDIS } from "../../infra/redis.js";
import { AccountRestrictions } from "../restrictions/account-restrictions.js";
import { SEASON_CLOSE_REPOSITORY, type SeasonClosed, type SeasonCloseRepository } from "./seasons-close.repository.js";
import { SeasonSchedule } from "./seasons-schedule.js";

/**
 * Закрытие недельных сезонов по расписанию (tasks/T-0110). Задание ходит
 * каждые 15 минут (`season-close.job.ts`) и закрывает **все** просроченные
 * сезоны подряд: сервер лежал две недели — закроет обе, по порядку.
 *
 * Три слоя защиты от двух реплик и повторов, каждый ловит своё:
 * - расписание BullMQ с одним id — задание выполняет одна реплика;
 * - лок Redis на всё закрытие — вторая, всё же запустившая его, уходит сразу
 *   (токен в значении: чужой лок не снимается);
 * - уникальный `season_key` в базе — последняя гарантия, если лок потерялся
 *   (`seasons-close.repository.ts`).
 *
 * Событие `season_closed` пишется только тем, кто закрыл: вставка строки
 * сезона прошла у него.
 */

/** Закрытие большого сезона идёт долго; лок отпускается в `finally`, срок — страховка от упавшего процесса. */
const LOCK_KEY = "seasons:close:lock";
const LOCK_TTL_MS = 10 * 60_000;
const REDIS_TIMEOUT_MS = 2_000;
const DB_TIMEOUT_MS = 3_000;
const CLOSE_TIMEOUT_MS = 130_000;

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

@Injectable()
export class SeasonsCloseService {
  private readonly logger = new Logger("seasons");

  constructor(
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "eval">,
    private readonly schedule: SeasonSchedule,
    @Inject(SEASON_CLOSE_REPOSITORY) private readonly repository: SeasonCloseRepository,
    private readonly restrictions: AccountRestrictions,
  ) {}

  /**
   * Закрыть просроченные сезоны. Возвращает закрытые этим вызовом; пусто —
   * закрывать нечего; `null` — закрытие идёт у другой реплики.
   */
  async closeDue(now = new Date()): Promise<SeasonClosed[] | null> {
    const due = this.schedule.due(now);
    if (due.length === 0) return [];

    const token = randomUUID();
    if ((await withTimeout(this.redis.set(LOCK_KEY, token, "PX", LOCK_TTL_MS, "NX"), REDIS_TIMEOUT_MS, "seasons: лок закрытия")) === null) return null;
    try {
      const closed = await withTimeout(this.repository.closedKeys(due.map((season) => season.key)), DB_TIMEOUT_MS, "seasons: закрытые сезоны");
      const todo = due.filter((season) => !closed.has(season.key));
      if (todo.length === 0) return [];
      // Кому рейтинг закрыт на момент закрытия — в итогах нет и награды не получит.
      const excluded = await withTimeout(this.restrictions.restrictedAccounts("leaderboard", now), DB_TIMEOUT_MS, "seasons: ограничения");

      const result: SeasonClosed[] = [];
      for (const season of todo) {
        const startedAt = Date.now();
        const outcome = await withTimeout(this.repository.close(season, excluded, now), CLOSE_TIMEOUT_MS, `seasons: закрытие ${season.key}`);
        // `null` — сезон успела закрыть другая реплика: событие её, не наше.
        if (outcome === null) continue;
        result.push(outcome);
        this.announce(outcome, Date.now() - startedAt);
      }
      return result;
    } finally {
      await this.release(token);
    }
  }

  /** Событие `season_closed` (docs/22-analytics-and-metrics.md §3.3): серверное, поэтому строка лога, а не конверт устройства. */
  private announce(closed: SeasonClosed, durationMs: number): void {
    this.logger.log(
      JSON.stringify({
        module: "seasons",
        event: "season_closed",
        season: closed.seasonKey,
        players: closed.players,
        rewarded: closed.rewarded,
        coins_total: closed.coinsTotal,
        prestige_total: closed.prestigeTotal,
        board_size: closed.boardSize,
        duration_ms: durationMs,
      }),
    );
  }

  private async release(token: string): Promise<void> {
    try {
      await withTimeout(this.redis.eval(RELEASE_SCRIPT, 1, LOCK_KEY, token) as Promise<unknown>, REDIS_TIMEOUT_MS, "seasons: снятие лока");
    } catch (error: unknown) {
      // Лок живёт не дольше TTL: следующее закрытие через 15 минут увидит его свободным.
      this.logger.warn(JSON.stringify({ module: "seasons", event: "close_lock_not_released", reason: error instanceof Error ? error.message : "unknown" }));
    }
  }
}
