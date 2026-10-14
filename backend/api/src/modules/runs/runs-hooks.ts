import { Injectable, Logger } from "@nestjs/common";
import type { Difficulty } from "./run-rules.js";
import type { RunVerdict, VerdictReason } from "./run-verdict.js";

/**
 * Забег записан — кому это интересно: сводке плейтеста, карточке
 * подозрительного забега в чате администраторов. Модуль забегов о них не
 * знает: слушатели подписываются сами, и новый потребитель не требует правки
 * приёма (тот же приём, что `DiagnosticsHooks`).
 *
 * Событие — только о **первой** записи. Повтор итога из очереди клиента
 * слушателей не зовёт: иначе сводка посчитала бы забег дважды, а в чат
 * пришли бы две карточки об одном.
 */
export interface RecordedRun {
  runId: string;
  accountId: string;
  difficulty: Difficulty;
  outcome: "died" | "abandoned";
  survivalSec: number;
  level: number;
  enemiesKilled: number;
  startingWeaponId: string;
  deathCause: string | null;
  cheats: boolean;
  /** сколько вторых шансов взято: оплаченные сверх этого числа не использованы */
  continues: number;
  /** попал ли в рейтинг */
  ranked: boolean;
  verdict: RunVerdict;
  reasons: VerdictReason[];
  finishedAt: Date;
}

export type RunListener = (run: RecordedRun) => Promise<void>;

/** Забег начался на сервере — впервые: повтор старта из очереди клиента слушателей не зовёт. */
export interface StartedRun {
  runId: string;
  accountId: string;
  /** по часам сервера */
  at: Date;
}

export type StartListener = (run: StartedRun) => Promise<void>;

/**
 * Модератор снял забег с рейтинга или вернул его: рейтинговое лучшее время
 * игрока на сложности могло измениться. Проекции рейтинга, кроме вечного (его
 * `RunsService` пересчитывает сам), пересчитывают его по базе — недельная
 * таблица сезона (tasks/T-0110).
 */
export interface RankingChange {
  accountId: string;
  difficulty: Difficulty;
}

export type RankingListener = (change: RankingChange) => Promise<void>;

@Injectable()
export class RunsHooks {
  private readonly logger = new Logger("runs");
  private readonly listeners: { name: string; listener: RunListener }[] = [];
  private readonly startListeners: { name: string; listener: StartListener }[] = [];
  private readonly rankingListeners: { name: string; listener: RankingListener }[] = [];

  onRecorded(name: string, listener: RunListener): void {
    this.listeners.push({ name, listener });
  }

  onStarted(name: string, listener: StartListener): void {
    this.startListeners.push({ name, listener });
  }

  onRankingChanged(name: string, listener: RankingListener): void {
    this.rankingListeners.push({ name, listener });
  }

  /** После снятия забега или возврата: упавший слушатель не мешает остальным и не отменяет решение модератора. */
  async emitRankingChanged(change: RankingChange): Promise<void> {
    await Promise.all(
      this.rankingListeners.map(async ({ name, listener }) => {
        try {
          await listener(change);
        } catch (error: unknown) {
          this.logger.error(
            JSON.stringify({
              module: "runs",
              event: "ranking_listener_failed",
              listener: name,
              accountId: change.accountId,
              reason: error instanceof Error ? error.message : "unknown",
            }),
          );
        }
      }),
    );
  }

  /** Как `emit`: после ответа игроку, упавший слушатель не мешает остальным. */
  emitStarted(run: StartedRun): Promise<void> {
    return Promise.all(
      this.startListeners.map(async ({ name, listener }) => {
        try {
          await listener(run);
        } catch (error: unknown) {
          this.logger.error(
            JSON.stringify({
              module: "runs",
              event: "start_listener_failed",
              listener: name,
              runId: run.runId,
              reason: error instanceof Error ? error.message : "unknown",
            }),
          );
        }
      }),
    ).then(() => undefined);
  }

  /**
   * Слушатели работают после ответа игроку и друг другу не мешают: упавшая
   * сводка не должна отменять карточку, а медленная карточка — держать ответ.
   */
  emit(run: RecordedRun): Promise<void> {
    return Promise.all(
      this.listeners.map(async ({ name, listener }) => {
        try {
          await listener(run);
        } catch (error: unknown) {
          this.logger.error(
            JSON.stringify({
              module: "runs",
              event: "listener_failed",
              listener: name,
              runId: run.runId,
              reason: error instanceof Error ? error.message : "unknown",
            }),
          );
        }
      }),
    ).then(() => undefined);
  }
}
