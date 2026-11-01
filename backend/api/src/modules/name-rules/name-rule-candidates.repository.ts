import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { CANDIDATE_RULES } from "./name-rule-candidates-rules.js";

/**
 * Кандидаты в правила фильтра имён в базе (`name_rule_candidate`, Р168,
 * tasks/T-0341): слово или пара слов и число разных игроков. Ников, id игроков
 * и связи «слово → игрок» таблица не хранит — столбцов под них нет.
 * Запросы живут здесь, а не в сервисе (docs/15-engineering-standards.md §2.3).
 */

export type CandidateKind = "word" | "pair";

/** Что расчёт отдаёт на запись: только агрегат. */
export interface CandidateItem {
  token: string;
  kind: CandidateKind;
  players: number;
}

export interface StoredCandidate extends CandidateItem {
  candidateId: string;
  firstSeenAt: Date;
  computedAt: Date;
  dismissedAt: Date | null;
  dismissedBy: string | null;
}

export const NAME_RULE_CANDIDATES_REPOSITORY = Symbol("NAME_RULE_CANDIDATES_REPOSITORY");

export interface NameRuleCandidatesRepository {
  /**
   * Записать итог расчёта одним проходом: новые слова заводятся, известным
   * обновляется число игроков и время расчёта (`first_seen_at` и скрытие не
   * трогаются); слова, упавшие ниже порога, и скрытые, которых не считали
   * дольше срока забывания, удаляются.
   */
  save(items: readonly CandidateItem[], startedAt: Date): Promise<void>;
  /** Нескрытые, по убыванию числа игроков. */
  list(limit: number): Promise<StoredCandidate[]>;
  find(candidateId: string): Promise<StoredCandidate | null>;
  /** `false` — такого кандидата уже нет */
  remove(candidateId: string): Promise<boolean>;
  /** Вид скрытого кандидата; `null` — такого нет. */
  dismiss(candidateId: string, by: string, at: Date): Promise<{ kind: CandidateKind } | null>;
}

const DAY_MS = 86_400_000;

@Injectable()
export class PrismaNameRuleCandidatesRepository implements NameRuleCandidatesRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async save(items: readonly CandidateItem[], startedAt: Date): Promise<void> {
    const forgetBefore = new Date(startedAt.getTime() - CANDIDATE_RULES.dismissedKeepDays * DAY_MS);
    await this.prisma.$transaction(async (tx) => {
      if (items.length > 0) {
        const tokens = items.map((item) => item.token);
        const kinds = items.map((item) => item.kind);
        const players = items.map((item) => item.players);
        // Идентификаторы заводит база (`gen_random_uuid`); при конфликте строка остаётся своей — не двигаются ни id, ни `first_seen_at`, ни скрытие.
        await tx.$executeRaw`
          INSERT INTO name_rule_candidate (candidate_id, token, kind, players, first_seen_at, computed_at)
          SELECT gen_random_uuid(), t.token, t.kind::"NameCandidateKind", t.players, ${startedAt}, ${startedAt}
          FROM unnest(${tokens}::text[], ${kinds}::text[], ${players}::int[]) AS t(token, kind, players)
          ON CONFLICT (kind, token) DO UPDATE SET players = EXCLUDED.players, computed_at = EXCLUDED.computed_at`;
      }
      await tx.$executeRaw`DELETE FROM name_rule_candidate WHERE computed_at < ${startedAt} AND dismissed_at IS NULL`;
      await tx.$executeRaw`DELETE FROM name_rule_candidate WHERE dismissed_at IS NOT NULL AND computed_at < ${forgetBefore}`;
    });
  }

  async list(limit: number): Promise<StoredCandidate[]> {
    const rows = await this.prisma.nameRuleCandidate.findMany({ where: { dismissedAt: null }, orderBy: [{ players: "desc" }, { token: "asc" }], take: limit });
    return rows;
  }

  async find(candidateId: string): Promise<StoredCandidate | null> {
    return await this.prisma.nameRuleCandidate.findUnique({ where: { candidateId } });
  }

  async remove(candidateId: string): Promise<boolean> {
    const result = await this.prisma.nameRuleCandidate.deleteMany({ where: { candidateId } });
    return result.count > 0;
  }

  async dismiss(candidateId: string, by: string, at: Date): Promise<{ kind: CandidateKind } | null> {
    const row = await this.prisma.nameRuleCandidate.findUnique({ where: { candidateId } });
    if (row === null) return null;
    await this.prisma.nameRuleCandidate.update({ where: { candidateId }, data: { dismissedAt: at, dismissedBy: by } });
    return { kind: row.kind };
  }
}
