import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { REDIS } from "../../infra/redis.js";
import { BotMentions } from "../../platforms/ports/bot-mention.js";
import { PLATFORM_IDS } from "../../platforms/ports/platform.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { gameDayOf } from "../tasks/task-pool.js";
import { BotMentionBackoff } from "./bot-mention-backoff.js";
import { BOT_MENTION_KINDS, SWEEP_BUDGET_SEC, canCheckUserId, offeredKinds, type BotMentionKind } from "./bot-mention-rules.js";
import { BOT_MENTION_REPOSITORY, type BotMentionRepository, type DueAccount } from "./bot-mention.repository.js";
import { BotMentionService } from "./bot-mention.service.js";

/**
 * Ночной проход заданий «юзернейм бота» (tasks/T-0162, шаг 5): раз в сутки на
 * аккаунт, оба вида одним вызовом порта, пачкой в пределах лимита площадки.
 * Планировщик (`bot-mention.job.ts`) запускает его каждые пять минут, и до
 * следующих суток проверенный аккаунт в очередь не попадает.
 *
 * - **Половина темпа бота.** Вторая половина — рассылкам, уведомлениям и
 *   проверкам игроков: пачка и пауза между вызовами считаются от
 *   `ratePerSec / 2`.
 * - **Лок** в Redis на время прохода: две реплики разом не ходят на площадку.
 *   Токен в значении — чужой лок не снимается; срок — страховка от упавшего
 *   процесса.
 * - **`retry` от площадки** обрывает проход и ставит общую паузу
 *   (`bot-mention-backoff.ts`) — на её срок ходить не будет и ручная проверка.
 * - **Сутки награды — на момент ответа площадки.** Проход идёт минуты и может
 *   пересечь полночь по Москве: аккаунт, проверенный после неё, получает
 *   награду за новые сутки, а не за те, в которые проход начался.
 */

const LOCK_KEY = "bot-mention:sweep:lock";
/** Проход укладывается в минуты; лок отпускается в `finally`, срок — страховка. */
const LOCK_TTL_MS = 600_000;
/** Проход заканчивается раньше, чем истечёт лок, — иначе вторая реплика вошла бы в чужой проход. */
const MAX_PASS_MS = 480_000;
const REDIS_TIMEOUT_MS = 2_000;
const DB_TIMEOUT_MS = 5_000;
/** Подряд столько сбоев начисления — это сбой системы, а не «ядовитый» аккаунт: проход останавливается. */
const MAX_CONSECUTIVE_FAILURES = 3;

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

export type SweepResult =
  | { status: "skipped"; reason: "disabled" | "paused" | "locked" }
  | { status: "done"; checked: number; unavailable: number; retried: number; failed: number; stopped: boolean };

@Injectable()
export class BotMentionSweepService {
  private readonly logger = new Logger("bot-mention");
  /** Пауза между вызовами площадки; тест подменяет, чтобы не ждать. */
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Часы; тест двигает их, чтобы пересечь границу суток. */
  clock: () => Date = () => new Date();
  /** Сколько секунд темпа бота тратит проход; тест уменьшает, чтобы не создавать тысячи аккаунтов. */
  budgetSec = SWEEP_BUDGET_SEC;

  constructor(
    @Inject(BOT_MENTION_REPOSITORY) private readonly repository: BotMentionRepository,
    private readonly mentions: BotMentions,
    private readonly service: BotMentionService,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "eval">,
    private readonly backoff: BotMentionBackoff,
  ) {}

  async run(): Promise<SweepResult> {
    const kinds = offeredKinds(this.settings);
    if (kinds.length === 0) return { status: "skipped", reason: "disabled" };

    const token = randomUUID();
    if ((await withTimeout(this.redis.set(LOCK_KEY, token, "PX", LOCK_TTL_MS, "NX"), REDIS_TIMEOUT_MS, "bot-mention: лок прохода")) === null) {
      return { status: "skipped", reason: "locked" };
    }
    try {
      if ((await this.backoff.remainingMs()) > 0) return { status: "skipped", reason: "paused" };
      return await this.sweep(kinds);
    } finally {
      await this.release(token);
    }
  }

  private async sweep(kinds: readonly BotMentionKind[]): Promise<SweepResult> {
    const startedAt = Date.now();
    const today = gameDayOf(this.clock());
    const total = { status: "done" as const, checked: 0, unavailable: 0, retried: 0, failed: 0, stopped: false };
    let failuresInRow = 0;

    for (const platform of PLATFORM_IDS) {
      const port = this.mentions.for(platform);
      if (port === null) continue;
      const rate = port.ratePerSec / 2;
      const limit = Math.floor((port.ratePerSec * this.budgetSec) / 2);
      const gapMs = Math.ceil(1000 / rate);
      const due = await this.db(this.repository.due(platform, today, kinds, limit));
      const tick = { checked: 0, retried: 0, unavailable: 0 };
      let asked = false;

      for (const entry of due) {
        if (Date.now() - startedAt > MAX_PASS_MS) {
          total.stopped = true;
          break;
        }
        const entryKinds = BOT_MENTION_KINDS.filter((kind) => entry.kinds.includes(kind));
        if (!canCheckUserId(entry.platformUserId)) {
          await this.markUnavailable(entry, entryKinds);
          tick.unavailable++;
          continue;
        }
        if (asked) await this.pause(gapMs);
        asked = true;

        const outcome = await this.service.ask(port, entry.platformUserId, entryKinds);
        if (outcome.status === "retry") {
          await this.service.pauseFor(outcome.afterSec);
          tick.retried++;
          total.stopped = true;
          break;
        }
        let kindNow: BotMentionKind = entryKinds[0] ?? "name";
        try {
          if (outcome.status === "unavailable") {
            await this.markUnavailable(entry, entryKinds);
            tick.unavailable++;
          } else {
            // Сутки — на момент ответа площадки: проход мог пересечь полночь по Москве.
            const at = this.clock();
            const day = gameDayOf(at);
            for (const kind of entryKinds) {
              kindNow = kind;
              await this.service.settle(entry.accountId, kind, outcome.findings[kind] ?? "unavailable", day, at);
            }
            tick.checked++;
          }
          failuresInRow = 0;
        } catch (error: unknown) {
          total.failed++;
          failuresInRow++;
          this.logger.warn(
            JSON.stringify({ module: "bot-mention", event: "bot_mention_account_failed", accountId: entry.accountId, kind: kindNow, reason: error instanceof Error ? error.name : "unknown" }),
          );
          if (failuresInRow >= MAX_CONSECUTIVE_FAILURES) {
            total.stopped = true;
            break;
          }
        }
      }

      total.checked += tick.checked;
      total.retried += tick.retried;
      total.unavailable += tick.unavailable;
      if (due.length > 0) this.logger.log(JSON.stringify({ module: "bot-mention", event: "bot_mention_tick", platform, ...tick }));
      if (total.stopped) break;
    }
    return total;
  }

  /** Проверить нельзя и повтор не поможет: до следующих суток аккаунт квоту не ест. */
  private async markUnavailable(entry: DueAccount, kinds: readonly BotMentionKind[]): Promise<void> {
    const at = this.clock();
    const day = gameDayOf(at);
    for (const kind of kinds) await this.db(this.repository.markChecked(entry.accountId, kind, day, "unavailable", at));
  }

  private async release(token: string): Promise<void> {
    try {
      await withTimeout(this.redis.eval(RELEASE_SCRIPT, 1, LOCK_KEY, token) as Promise<unknown>, REDIS_TIMEOUT_MS, "bot-mention: снятие лока");
    } catch (error: unknown) {
      // Лок живёт не дольше TTL: следующий проход через пять минут увидит его свободным.
      this.logger.warn(JSON.stringify({ module: "bot-mention", event: "sweep_lock_not_released", reason: error instanceof Error ? error.name : "unknown" }));
    }
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "bot-mention");
  }
}
