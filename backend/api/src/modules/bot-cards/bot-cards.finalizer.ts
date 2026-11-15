import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import { BotNotifyQueue } from "../notifications-bot/bot-notify-queue.js";
import { BotCardKinds } from "./bot-card-kinds.js";
import { CARD_FLAGS, CARD_JOBS, FINAL_LOCK_KEY, acquireLock, encodeState, pacedJobId, parseState, releaseLock } from "./bot-card-protocol.js";
import { BOT_CARDS_REPOSITORY, type BotCardsRepository } from "./bot-cards.repository.js";

/**
 * Финал периода живых карточек (docs/35-stage4-plan.md Р199, tasks/T-0395). Раз в `FINAL_SCAN_MS`
 * проход под локом Redis берёт у каждого вида с периодом живые карточки другого периода и ставит им
 * задание `card-final`; правку и закрытие делает `BotCardsUpdater`.
 *
 * - **Один проход на все реплики**: лок с токеном (как у планировщика напоминаний);
 * - **финал — состояние карточки своего периода**, а не нового: карточка закрывает свою неделю, поэтому
 *   берётся сохранённое состояние с `x: 1` или то, что собрал `finalState` вида;
 * - проход не зависит от выключателей карточек: выключенные карточки закрываются без правки, чтобы не
 *   копиться живыми вечно (`BotCardsUpdater.final`);
 * - повторный проход ничего не удваивает: задание одно на карточку, пока оно не выполнено.
 */

/** Как часто проход просыпается. */
export const FINAL_SCAN_MS = 600_000;
/** Сколько карточек одного вида проход берёт за раз: остальные — на следующем. */
const BATCH_LIMIT = 500;
/** Проход укладывается в секунды, а интервал — десять минут: лок не должен пережить следующий проход. */
const LOCK_TTL_MS = 300_000;

export interface FinalSummary {
  status: "done" | "locked" | "failed";
  /** сколько заданий `card-final` поставлено (в том числе уже стоявших) */
  queued: number;
}

@Injectable()
export class BotCardsFinalizer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("bot-cards");
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly kinds: BotCardKinds,
    @Inject(BOT_CARDS_REPOSITORY) private readonly repository: BotCardsRepository,
    @Inject(BotNotifyQueue) private readonly queue: Pick<BotNotifyQueue, "addPaced">,
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "eval">,
  ) {}

  /** Без входа игроков нет аккаунтов, а значит и карточек. */
  onApplicationBootstrap(): void {
    if (!this.config.auth.enabled) return;
    this.timer = setInterval(() => void this.tick(), FINAL_SCAN_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** Один проход. Не бросает: сбой — строка в логе, следующий проход начнёт заново. */
  async tick(now = new Date()): Promise<FinalSummary> {
    let token: string | null;
    try {
      token = await acquireLock(this.redis, FINAL_LOCK_KEY, LOCK_TTL_MS);
    } catch (error: unknown) {
      this.warn("final_lock_unavailable", error);
      return { status: "failed", queued: 0 };
    }
    if (token === null) return { status: "locked", queued: 0 };
    let queued = 0;
    try {
      for (const kind of this.kinds.all()) {
        const period = kind.periodKey(now);
        if (period === null) continue;
        try {
          for (const card of await this.repository.dueForFinal(kind.kind, period, BATCH_LIMIT)) {
            const last = parseState(card.state);
            if (last === null) {
              this.logger.warn(JSON.stringify({ module: "bot-cards", event: "final_state_unreadable", card: kind.kind }));
              continue;
            }
            let state: string;
            try {
              state = encodeState(kind.finalState?.(last, now) ?? { ...last, [CARD_FLAGS.closed]: 1 });
            } catch (error: unknown) {
              // Ошибка вида (финал не умещается в предел): одна карточка, а не весь проход.
              this.warn("final_state_invalid", error, kind.kind);
              continue;
            }
            if (await this.queue.addPaced(CARD_JOBS.final, { cardId: card.id, state }, { jobId: pacedJobId(CARD_JOBS.final, card.id), delayMs: 0 })) queued++;
          }
        } catch (error: unknown) {
          // Один вид не должен останавливать остальные: его карточки подберёт следующий проход.
          this.warn("final_scan_failed", error, kind.kind);
        }
      }
    } finally {
      await releaseLock(this.redis, FINAL_LOCK_KEY, token).catch((error: unknown) => this.warn("unlock_failed", error));
    }
    return { status: "done", queued };
  }

  private warn(event: string, error: unknown, card?: string): void {
    this.logger.warn(JSON.stringify({ module: "bot-cards", event, ...(card === undefined ? {} : { card }), reason: error instanceof Error ? error.message : String(error) }));
  }
}
