import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { REPLAY_STATES, replayResultSchema, type ReplayOutcome, type ReplayState, type ReplayedTotals } from "./run-replay-rules.js";
import type { RunVerdict, VerdictReason } from "./run-verdict.js";

/**
 * Перепроверка забегов в Postgres (tasks/T-0319): состояние повтора в строке
 * `run`, постановка в очередь, снятие исхода, «Повторить снова» и чтение для
 * разбора. Все переходы — условные `UPDATE`: две реплики сервера, исход,
 * пришедший дважды, и решение модератора посреди повтора упираются в базу, а не
 * в «прочитал, проверил, записал» (docs/15-engineering-standards.md §4.1).
 *
 * Конечный автомат одной строки: `null` → `pending` (решили повторять) → исход.
 * Из исхода обратно в `pending` забег переводит только `reset` — «Повторить
 * снова», с новым номером попытки.
 */

export const RUN_REPLAY_REPOSITORY = Symbol("RUN_REPLAY_REPOSITORY");

/** Забег в том, что нужно перепроверке: итог, вердикт, состояние повтора. */
export interface ReplayRunRow {
  runId: string;
  accountId: string;
  /** площадка аккаунта — в конверт серверного события */
  accountPlatform: "telegram" | "max" | "vk" | "web";
  status: "started" | "finished";
  finishedAt: Date | null;
  contentHash: string;
  survivalSec: number | null;
  level: number | null;
  enemiesKilled: number | null;
  verdict: RunVerdict | null;
  verdictReasons: string[];
  ranked: boolean;
  /** решение разбора (Р203): `honest` или `annulled`; `null` — не разбирался */
  reviewOutcome: string | null;
  replayVerdict: ReplayState | null;
  replayRequired: boolean;
  replayAttempt: number;
  replayQueuedAt: Date | null;
}

/** Забег, у которого пора что-то сделать с очередью. */
export interface DueRun {
  runId: string;
  required: boolean;
  attempt: number;
  /** когда поставлено; `null` — ещё не ставилось */
  queuedAt: Date | null;
}

/** Что воркер насчитал — для таблицы «заявлено / повтор» в разборе. */
export interface StoredReplayResult {
  reason: string | null;
  replayed: ReplayedTotals | null;
  durationMs: number;
}

/** Исход повтора забега, как его читает разбор. */
export interface StoredReplay {
  verdict: ReplayState;
  required: boolean;
  divergedTick: number | null;
  replayedAt: Date | null;
  result: StoredReplayResult | null;
  /** что клиент заявил об итоге — колонки забега */
  claimed: { survivalSec: number; level: number; enemiesKilled: number };
  hasProof: boolean;
}

/** Снятый исход: что записать в забег и что сделать с вердиктом, рейтингом и записью. */
export interface Settlement {
  runId: string;
  /** попытка, к которой относится исход: исход прошлой попытки на новую не ложится */
  attempt: number;
  outcome: ReplayOutcome;
  divergedTick: number | null;
  at: Date;
  result: StoredReplayResult;
  /** новый вердикт забега; `null` — не меняется */
  verdict: RunVerdict | null;
  /** причина, которая дописывается к причинам вердикта */
  reason: VerdictReason | null;
  /** снять забег с рейтинга */
  unrank: boolean;
  /** продлить хранение записи до этого срока; `null` — не трогать */
  keepProofUntil: Date | null;
}

export interface SettleResult {
  /** исход записан: забег ждал именно эту попытку */
  applied: boolean;
  /** забег был в рейтинге и вышел из него: доски пора пересчитать */
  demoted: boolean;
}

export type ResetResult = { status: "reset"; attempt: number; required: boolean } | { status: "missing" } | { status: "pending" } | { status: "no_proof" };

export interface RunReplayRepository {
  find(runId: string): Promise<ReplayRunRow | null>;
  /**
   * Решили повторять: `null` → `pending`. `true` — строка стала «ожидает» только что.
   * Забег, который уже ждёт или уже повторён, не меняется, но обязательность ему
   * можно только прибавить: повтор, ставший нужным позже (редкая добыча), её не теряет.
   */
  markPending(runId: string, required: boolean): Promise<boolean>;
  /** занять постановку в очередь; возвращает номер попытки, `null` — занято другим или забег не ждёт */
  claimQueue(runId: string, at: Date): Promise<number | null>;
  /** вернуть отметку постановки, если задание не поставилось (Redis недоступен): следующий проход повторит */
  releaseQueue(runId: string, at: Date): Promise<void>;
  /** отодвинуть срок постановки, пока предыдущее значение не изменилось — одна реплика из нескольких */
  requeue(runId: string, from: Date, to: Date): Promise<boolean>;
  /** ждущие постановки: запись пришла, задания нет; обязательные первыми */
  dueForQueue(limit: number): Promise<DueRun[]>;
  /** поставлены до `before` и всё ещё ждут исхода */
  staleQueued(before: Date, limit: number): Promise<DueRun[]>;
  /** ждут исхода, закончились до `before`, а записи нет */
  withoutProof(before: Date, limit: number): Promise<string[]>;
  settle(settlement: Settlement): Promise<SettleResult>;
  /** «Повторить снова»: из любого состояния, кроме «ожидает», обратно в «ожидает» с новой попыткой */
  reset(runId: string): Promise<ResetResult>;
  outcomesOf(runIds: readonly string[]): Promise<Map<string, StoredReplay>>;
  /** последняя сессия игрока до момента `at`, а нет её — любая; `null` — сессий нет */
  clientSession(accountId: string, at: Date): Promise<{ os: string; deviceClass: string } | null>;
  /** снимок контента, который нужно приложить к заданию; `null` — прикладывать нечего */
  snapshotOf(contentHash: string): Promise<unknown>;
}

const isState = (value: string | null): value is ReplayState => value !== null && (REPLAY_STATES as readonly string[]).includes(value);

/** Колонка `replay_result` — данные базы: форму проверяем, битое читается как «нет подробностей». */
const storedResultSchema = z.object({ reason: z.string().nullable(), replayed: replayResultSchema.shape.replayed, durationMs: z.number().int().nonnegative() });

function resultOf(value: unknown): StoredReplayResult | null {
  const parsed = storedResultSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

@Injectable()
export class PrismaRunReplayRepository implements RunReplayRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async find(runId: string): Promise<ReplayRunRow | null> {
    const row = await this.prisma.run.findUnique({
      where: { runId },
      select: {
        runId: true,
        accountId: true,
        account: { select: { platform: true } },
        status: true,
        finishedAt: true,
        contentHash: true,
        survivalSec: true,
        level: true,
        enemiesKilled: true,
        verdict: true,
        verdictReasons: true,
        ranked: true,
        reviewOutcome: true,
        replayVerdict: true,
        replayRequired: true,
        replayAttempt: true,
        replayQueuedAt: true,
      },
    });
    if (row === null) return null;
    const { account, ...rest } = row;
    return { ...rest, accountPlatform: account.platform, replayVerdict: isState(row.replayVerdict) ? row.replayVerdict : null };
  }

  async markPending(runId: string, required: boolean): Promise<boolean> {
    const created = await this.prisma.run.updateMany({ where: { runId, status: "finished", replayVerdict: null }, data: { replayVerdict: "pending", replayRequired: required } });
    if (created.count > 0) return true;
    if (required) await this.prisma.run.updateMany({ where: { runId, status: "finished", replayVerdict: { not: null }, replayRequired: false }, data: { replayRequired: true } });
    return false;
  }

  async claimQueue(runId: string, at: Date): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<{ replay_attempt: number }[]>`
      UPDATE run SET replay_queued_at = ${at}
      WHERE run_id = ${runId} AND replay_verdict = 'pending' AND replay_queued_at IS NULL
      RETURNING replay_attempt`;
    return rows[0]?.replay_attempt ?? null;
  }

  async releaseQueue(runId: string, at: Date): Promise<void> {
    await this.prisma.run.updateMany({ where: { runId, replayVerdict: "pending", replayQueuedAt: at }, data: { replayQueuedAt: null } });
  }

  async requeue(runId: string, from: Date, to: Date): Promise<boolean> {
    const moved = await this.prisma.run.updateMany({ where: { runId, replayVerdict: "pending", replayQueuedAt: from }, data: { replayQueuedAt: to } });
    return moved.count > 0;
  }

  async dueForQueue(limit: number): Promise<DueRun[]> {
    const rows = await this.prisma.run.findMany({
      where: { replayVerdict: "pending", replayQueuedAt: null, proof: { isNot: null } },
      orderBy: [{ replayRequired: "desc" }, { finishedAt: "asc" }],
      take: limit,
      select: { runId: true, replayRequired: true, replayAttempt: true },
    });
    return rows.map((row) => ({ runId: row.runId, required: row.replayRequired, attempt: row.replayAttempt, queuedAt: null }));
  }

  async staleQueued(before: Date, limit: number): Promise<DueRun[]> {
    const rows = await this.prisma.run.findMany({
      where: { replayVerdict: "pending", replayQueuedAt: { lt: before } },
      orderBy: { replayQueuedAt: "asc" },
      take: limit,
      select: { runId: true, replayRequired: true, replayAttempt: true, replayQueuedAt: true },
    });
    return rows.map((row) => ({ runId: row.runId, required: row.replayRequired, attempt: row.replayAttempt, queuedAt: row.replayQueuedAt }));
  }

  async withoutProof(before: Date, limit: number): Promise<string[]> {
    const rows = await this.prisma.run.findMany({
      where: { replayVerdict: "pending", finishedAt: { lt: before }, proof: { is: null } },
      orderBy: { finishedAt: "asc" },
      take: limit,
      select: { runId: true },
    });
    return rows.map((row) => row.runId);
  }

  async settle(settlement: Settlement): Promise<SettleResult> {
    const { runId, attempt } = settlement;
    return await this.prisma.$transaction(async (tx) => {
      // Первое условное обновление занимает строку до конца транзакции: решение модератора, пришедшее посреди исхода, ждёт.
      const applied = await tx.run.updateMany({
        where: { runId, replayVerdict: "pending", replayAttempt: attempt },
        data: {
          replayVerdict: settlement.outcome,
          replayDivergedTick: settlement.divergedTick,
          replayedAt: settlement.at,
          replayResult: { reason: settlement.result.reason, replayed: settlement.result.replayed, durationMs: settlement.result.durationMs },
        },
      });
      if (applied.count === 0) return { applied: false, demoted: false };

      // Решение разбора сильнее проверки: забег, который команда уже признала честным или аннулировала, не трогаем.
      let demoted = false;
      if (settlement.unrank) demoted = (await tx.run.updateMany({ where: { runId, reviewOutcome: null, ranked: true }, data: { ranked: false } })).count > 0;
      if (settlement.verdict !== null) {
        await tx.run.updateMany({
          where: { runId, reviewOutcome: null },
          data: { verdict: settlement.verdict, ...(settlement.reason === null ? {} : { verdictReasons: { push: settlement.reason } }) },
        });
      }
      if (settlement.keepProofUntil !== null) {
        await tx.$executeRaw`UPDATE run_proof SET keep_until = GREATEST(keep_until, ${settlement.keepProofUntil}) WHERE run_id = ${runId}`;
      }
      return { applied: true, demoted };
    });
  }

  async reset(runId: string): Promise<ResetResult> {
    const row = await this.prisma.run.findUnique({ where: { runId }, select: { status: true, replayVerdict: true, proof: { select: { runId: true } } } });
    if (row === null || row.status !== "finished") return { status: "missing" };
    if (row.replayVerdict === "pending") return { status: "pending" };
    if (row.proof === null) return { status: "no_proof" };
    // Условие в самом обновлении: два нажатия подряд дают одну новую попытку, второе увидит «ожидает».
    const rows = await this.prisma.$queryRaw<{ replay_attempt: number; replay_required: boolean }[]>`
      UPDATE run
      SET replay_verdict = 'pending', replay_queued_at = NULL, replay_diverged_tick = NULL, replayed_at = NULL, replay_result = NULL,
          replay_attempt = replay_attempt + 1
      WHERE run_id = ${runId} AND status = 'finished' AND (replay_verdict IS NULL OR replay_verdict <> 'pending')
      RETURNING replay_attempt, replay_required`;
    const reset = rows[0];
    return reset === undefined ? { status: "pending" } : { status: "reset", attempt: reset.replay_attempt, required: reset.replay_required };
  }

  async outcomesOf(runIds: readonly string[]): Promise<Map<string, StoredReplay>> {
    const found = new Map<string, StoredReplay>();
    if (runIds.length === 0) return found;
    const rows = await this.prisma.run.findMany({
      where: { runId: { in: [...runIds] }, replayVerdict: { not: null } },
      select: {
        runId: true,
        replayVerdict: true,
        replayRequired: true,
        replayDivergedTick: true,
        replayedAt: true,
        replayResult: true,
        survivalSec: true,
        level: true,
        enemiesKilled: true,
        proof: { select: { runId: true } },
      },
    });
    for (const row of rows) {
      if (!isState(row.replayVerdict)) continue;
      found.set(row.runId, {
        verdict: row.replayVerdict,
        required: row.replayRequired,
        divergedTick: row.replayDivergedTick,
        replayedAt: row.replayedAt,
        result: resultOf(row.replayResult),
        claimed: { survivalSec: row.survivalSec ?? 0, level: row.level ?? 0, enemiesKilled: row.enemiesKilled ?? 0 },
        hasProof: row.proof !== null,
      });
    }
    return found;
  }

  async clientSession(accountId: string, at: Date): Promise<{ os: string; deviceClass: string } | null> {
    const select = { os: true, deviceClass: true } as const;
    const before = await this.prisma.accountSession.findFirst({ where: { accountId, startedAt: { lte: at } }, orderBy: { startedAt: "desc" }, select });
    return before ?? (await this.prisma.accountSession.findFirst({ where: { accountId }, orderBy: { startedAt: "desc" }, select }));
  }

  async snapshotOf(contentHash: string): Promise<unknown> {
    // Последняя версия «из кода» — это контент, встроенный в сборку воркера: ему снимок не нужен, он повторяет по своему.
    // Приложенный снимок воркер проверяет по хэшу «как пришёл», а jsonb порядок ключей не хранит, поэтому лишний снимок — не помощь, а вес.
    const rows = await this.prisma.$queryRaw<{ snapshot: Prisma.JsonValue }[]>`
      SELECT snapshot FROM content_version
      WHERE content_hash = ${contentHash}
        AND content_hash IS DISTINCT FROM (SELECT content_hash FROM content_version WHERE source = 'repo' ORDER BY version_no DESC LIMIT 1)`;
    return rows[0]?.snapshot ?? null;
  }
}
