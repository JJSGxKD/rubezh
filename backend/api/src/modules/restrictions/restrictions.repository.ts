import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * Ограничения игрока в базе (`account_restriction`, docs/35-stage4-plan.md
 * WP44). Действует — не снято и срок не вышел: истечению запись не нужна,
 * его проверяет время. Последствия, которые живут вне таблицы, — блокировка
 * в `account.banned_at` — снимаются отдельно, и `settled_at` отмечает, что
 * это сделано.
 */

export interface RestrictionRow {
  restrictionId: string;
  accountId: string;
  /** строкой: вид, которого этот сервер ещё не знает, — запись панели новее кода */
  kind: string;
  startsAt: Date;
  endsAt: Date | null;
  reason: string;
  comment: string | null;
  notify: boolean;
  imposedBy: string | null;
  liftedAt: Date | null;
  liftedBy: string | null;
  liftComment: string | null;
  settledAt: Date | null;
}

export interface NewRestriction {
  accountId: string;
  kind: string;
  startsAt: Date;
  endsAt: Date | null;
  reason: string;
  comment: string | null;
  notify: boolean;
  imposedBy: string;
}

export const RESTRICTIONS_REPOSITORY = Symbol("RESTRICTIONS_REPOSITORY");

/** Новое ограничение того же вида заменяет действующее — у прежнего так и записано. */
export const REPLACED_COMMENT = "Заменено новым ограничением";

export interface RestrictionsRepository {
  /**
   * Наложить ограничения одного аккаунта. Действующие того же вида
   * снимаются в той же транзакции: у игрока одно ограничение вида, а не
   * стопка, и снятие из панели снимает его целиком.
   */
  impose(rows: readonly NewRestriction[], at: Date): Promise<{ created: RestrictionRow[]; replaced: RestrictionRow[] }>;
  /** Снять действующее; `null` — его нет, уже снято или срок вышел. */
  lift(restrictionId: string, liftedBy: string, comment: string, at: Date): Promise<RestrictionRow | null>;
  byId(restrictionId: string): Promise<RestrictionRow | null>;
  /** История аккаунта — новые сверху. */
  byAccount(accountId: string, limit: number): Promise<RestrictionRow[]>;
  active(accountId: string, at: Date): Promise<RestrictionRow[]>;
  /** Снятые или истёкшие, чьи последствия ещё не сняты. */
  unsettled(at: Date, limit: number): Promise<RestrictionRow[]>;
  markSettled(restrictionIds: readonly string[], at: Date): Promise<void>;
  /** Аккаунты с действующими ограничениями этих видов — обходу последствий и пересборке рейтинга. */
  activeAccounts(kinds: readonly string[], at: Date, limit: number): Promise<string[]>;
}

const activeAt = (at: Date) => ({ liftedAt: null, OR: [{ endsAt: null }, { endsAt: { gt: at } }] });

@Injectable()
export class PrismaRestrictionsRepository implements RestrictionsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async impose(rows: readonly NewRestriction[], at: Date): Promise<{ created: RestrictionRow[]; replaced: RestrictionRow[] }> {
    const first = rows[0];
    if (first === undefined) return { created: [], replaced: [] };
    const { accountId, imposedBy } = first;
    return await this.prisma.$transaction(async (tx) => {
      // Два модератора разом не заведут по ограничению одного вида каждый.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`restrictions:${accountId}`}))`;
      const replaced = await tx.accountRestriction.findMany({ where: { accountId, kind: { in: rows.map((row) => row.kind) }, ...activeAt(at) } });
      if (replaced.length > 0) {
        await tx.accountRestriction.updateMany({
          where: { restrictionId: { in: replaced.map((row) => row.restrictionId) } },
          data: { liftedAt: at, liftedBy: imposedBy, liftComment: REPLACED_COMMENT },
        });
      }
      const created: RestrictionRow[] = [];
      for (const row of rows) created.push(await tx.accountRestriction.create({ data: row }));
      return { created, replaced: replaced.map((row) => ({ ...row, liftedAt: at, liftedBy: imposedBy, liftComment: REPLACED_COMMENT })) };
    });
  }

  async lift(restrictionId: string, liftedBy: string, comment: string, at: Date): Promise<RestrictionRow | null> {
    // Условно: снятое и истёкшее второй раз не снимаются — повтор нажатия не
    // перепишет, кто и когда снял.
    const { count } = await this.prisma.accountRestriction.updateMany({
      where: { restrictionId, ...activeAt(at) },
      data: { liftedAt: at, liftedBy, liftComment: comment },
    });
    return count === 0 ? null : await this.byId(restrictionId);
  }

  async byId(restrictionId: string): Promise<RestrictionRow | null> {
    return await this.prisma.accountRestriction.findUnique({ where: { restrictionId } });
  }

  async byAccount(accountId: string, limit: number): Promise<RestrictionRow[]> {
    return await this.prisma.accountRestriction.findMany({ where: { accountId }, orderBy: { startsAt: "desc" }, take: limit });
  }

  async active(accountId: string, at: Date): Promise<RestrictionRow[]> {
    return await this.prisma.accountRestriction.findMany({ where: { accountId, ...activeAt(at) }, orderBy: { startsAt: "desc" } });
  }

  async unsettled(at: Date, limit: number): Promise<RestrictionRow[]> {
    return await this.prisma.accountRestriction.findMany({
      where: { settledAt: null, OR: [{ liftedAt: { not: null } }, { endsAt: { lte: at } }] },
      orderBy: { startsAt: "asc" },
      take: limit,
    });
  }

  async markSettled(restrictionIds: readonly string[], at: Date): Promise<void> {
    if (restrictionIds.length === 0) return;
    await this.prisma.accountRestriction.updateMany({ where: { restrictionId: { in: [...restrictionIds] }, settledAt: null }, data: { settledAt: at } });
  }

  async activeAccounts(kinds: readonly string[], at: Date, limit: number): Promise<string[]> {
    // Действующее ещё не сведено — `settled_at IS NULL` ведёт запрос по
    // частичному индексу несведённых, а не по всей истории.
    const rows = await this.prisma.accountRestriction.findMany({
      where: { kind: { in: [...kinds] }, settledAt: null, ...activeAt(at) },
      select: { accountId: true },
      distinct: ["accountId"],
      take: limit,
    });
    return rows.map((row) => row.accountId);
  }
}
