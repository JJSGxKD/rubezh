import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { Prisma } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { Role } from "../roles/permissions.js";
import { CHANGE_KINDS, CHANGE_STATUSES, jsonValueSchema, type ChangeKind, type ChangeRequestRow, type ChangeTx, type ClosedStatus, type JsonValue } from "./change-request-types.js";

/**
 * Заявки на правку в базе (`change_request`, docs/19-content-admin.md §6,
 * tasks/T-0309). Вся работа с заявкой и целью идёт в `locked`: транзакция под
 * блокировкой пары «вид + цель» — две заявки на одну цель и два подтверждения
 * одной заявки выстраиваются в очередь, а не гоняются. Запрос к базе живёт
 * здесь, а не в сервисе (docs/15-engineering-standards.md §2.3).
 */

export const CHANGE_REQUESTS_REPOSITORY = Symbol("CHANGE_REQUESTS_REPOSITORY");

/** Работа в одной транзакции под блокировкой цели. */
export interface ChangeSession {
  /** транзакция: вид правки читает и пишет цель в ней же — так цель и заявка меняются вместе или не меняются */
  readonly tx: ChangeTx;
  find(requestId: string): Promise<ChangeRequestRow | null>;
  /** живые заявки на цель: после блокировки их не больше одной, но код не полагается на это */
  pending(kind: ChangeKind, target: string): Promise<ChangeRequestRow[]>;
  insert(row: ChangeRequestRow): Promise<void>;
  /** закрыть живую заявку; `false` — она уже не живая: закрыл другой запрос или проход срока */
  close(requestId: string, status: ClosedStatus, by: string | null, at: Date): Promise<boolean>;
}

export interface ChangeRequestsRepository {
  /** Выполнить работу в транзакции под блокировкой цели. Исключение откатывает всё. */
  locked<T>(kind: ChangeKind, target: string, work: (session: ChangeSession) => Promise<T>): Promise<T>;
  find(requestId: string): Promise<ChangeRequestRow | null>;
  /** Все живые заявки и закрытые не старше `since`, свежие первыми. */
  list(since: Date, limit: number): Promise<ChangeRequestRow[]>;
  /** Закрыть как просроченные живые заявки, созданные раньше `createdBefore`; сколько закрыто. */
  expireOverdue(createdBefore: Date, at: Date): Promise<number>;
  /** Аккаунты с одной из ролей: им уходит уведомление о новой заявке. */
  peers(roles: readonly Role[]): Promise<string[]>;
}

const rowSchema = z.object({
  requestId: z.string(),
  kind: z.enum(CHANGE_KINDS),
  target: z.string(),
  before: jsonValueSchema,
  after: jsonValueSchema,
  reason: z.string(),
  author: z.string(),
  status: z.enum(CHANGE_STATUSES),
  decidedBy: z.string().nullable(),
  decidedAt: z.date().nullable(),
  createdAt: z.date(),
});

function toRow(raw: unknown): ChangeRequestRow {
  return rowSchema.parse(raw);
}

/** Пустое значение — `JsonNull`: колонка не допускает SQL `NULL`. */
function toInput(value: JsonValue): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

const TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;

@Injectable()
export class PrismaChangeRequestsRepository implements ChangeRequestsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async locked<T>(kind: ChangeKind, target: string, work: (session: ChangeSession) => Promise<T>): Promise<T> {
    return await this.prisma.$transaction(async (tx) => {
      // Блокировка живёт до конца транзакции: следующий, кто трогает эту цель, ждёт и видит результат этого.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`change_request:${kind}:${target}`}))`;
      return await work({
        tx,
        find: async (requestId) => {
          const row = await tx.changeRequest.findUnique({ where: { requestId } });
          return row === null ? null : toRow(row);
        },
        pending: async (pendingKind, pendingTarget) => {
          const rows = await tx.changeRequest.findMany({ where: { kind: pendingKind, target: pendingTarget, status: "pending" }, orderBy: { createdAt: "asc" } });
          return rows.map(toRow);
        },
        insert: async (row) => {
          await tx.changeRequest.create({
            data: {
              requestId: row.requestId,
              kind: row.kind,
              target: row.target,
              before: toInput(row.before),
              after: toInput(row.after),
              reason: row.reason,
              author: row.author,
              status: row.status,
              decidedBy: row.decidedBy,
              decidedAt: row.decidedAt,
              createdAt: row.createdAt,
            },
          });
        },
        close: async (requestId, status, by, at) => {
          const result = await tx.changeRequest.updateMany({ where: { requestId, status: "pending" }, data: { status, decidedBy: by, decidedAt: at } });
          return result.count === 1;
        },
      });
    }, TX_OPTIONS);
  }

  async find(requestId: string): Promise<ChangeRequestRow | null> {
    const row = await this.prisma.changeRequest.findUnique({ where: { requestId } });
    return row === null ? null : toRow(row);
  }

  async list(since: Date, limit: number): Promise<ChangeRequestRow[]> {
    const rows = await this.prisma.changeRequest.findMany({
      where: { OR: [{ status: "pending" }, { createdAt: { gte: since } }] },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(toRow);
  }

  async expireOverdue(createdBefore: Date, at: Date): Promise<number> {
    const result = await this.prisma.changeRequest.updateMany({
      where: { status: "pending", createdAt: { lt: createdBefore } },
      data: { status: "expired", decidedAt: at },
    });
    return result.count;
  }

  async peers(roles: readonly Role[]): Promise<string[]> {
    if (roles.length === 0) return [];
    const rows = await this.prisma.accountRole.findMany({ where: { role: { in: [...roles] } }, select: { accountId: true }, distinct: ["accountId"] });
    return rows.map((row) => row.accountId);
  }
}
