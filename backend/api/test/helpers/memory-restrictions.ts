import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { loadAppConfig } from "../../src/config/app-config.js";
import { AccountRestrictions } from "../../src/modules/restrictions/account-restrictions.js";
import { REPLACED_COMMENT, type NewRestriction, type RestrictionRow, type RestrictionsRepository } from "../../src/modules/restrictions/restrictions.repository.js";
import { AUTH_ENV } from "./auth-env.js";

/** Ограничения в памяти — тот же смысл «действует», что у базы: не снято и срок не вышел. */
export class MemoryRestrictionsRepository implements RestrictionsRepository {
  readonly rows: RestrictionRow[] = [];
  /** сколько раз спросили действующие — для проверки кеша */
  reads = 0;

  async impose(rows: readonly NewRestriction[], at: Date): Promise<{ created: RestrictionRow[]; replaced: RestrictionRow[] }> {
    const kinds = new Set(rows.map((row) => row.kind));
    const replaced: RestrictionRow[] = [];
    for (const row of this.rows) {
      if (row.accountId === rows[0]?.accountId && kinds.has(row.kind) && active(row, at)) {
        Object.assign(row, { liftedAt: at, liftedBy: rows[0].imposedBy, liftComment: REPLACED_COMMENT });
        replaced.push({ ...row });
      }
    }
    const created = rows.map((row) => ({ ...row, restrictionId: randomUUID(), liftedAt: null, liftedBy: null, liftComment: null, settledAt: null }));
    this.rows.push(...created.map((row) => ({ ...row })));
    return { created, replaced };
  }

  async lift(restrictionId: string, liftedBy: string, comment: string, at: Date): Promise<RestrictionRow | null> {
    const row = this.rows.find((candidate) => candidate.restrictionId === restrictionId);
    if (row === undefined || !active(row, at)) return null;
    Object.assign(row, { liftedAt: at, liftedBy, liftComment: comment });
    return { ...row };
  }

  async byId(restrictionId: string): Promise<RestrictionRow | null> {
    const row = this.rows.find((candidate) => candidate.restrictionId === restrictionId);
    return row === undefined ? null : { ...row };
  }

  async byAccount(accountId: string, limit: number): Promise<RestrictionRow[]> {
    return this.rows
      .filter((row) => row.accountId === accountId)
      .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async active(accountId: string, at: Date): Promise<RestrictionRow[]> {
    this.reads += 1;
    return this.rows.filter((row) => row.accountId === accountId && active(row, at)).map((row) => ({ ...row }));
  }

  async unsettled(at: Date, limit: number): Promise<RestrictionRow[]> {
    return this.rows
      .filter((row) => row.settledAt === null && (row.liftedAt !== null || (row.endsAt !== null && row.endsAt.getTime() <= at.getTime())))
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async markSettled(restrictionIds: readonly string[], at: Date): Promise<void> {
    for (const row of this.rows) if (restrictionIds.includes(row.restrictionId) && row.settledAt === null) row.settledAt = at;
  }

  async activeAccounts(kinds: readonly string[], at: Date, limit: number): Promise<string[]> {
    return [...new Set(this.rows.filter((row) => kinds.includes(row.kind) && active(row, at)).map((row) => row.accountId))].slice(0, limit);
  }

  /** Наложить в обход сервиса — для тестов модулей, которым важно только «закрыто». */
  restrict(accountId: string, kind: string, options: { notify?: boolean; endsAt?: Date | null; at?: Date; reason?: string } = {}): RestrictionRow {
    const row: RestrictionRow = {
      restrictionId: randomUUID(),
      accountId,
      kind,
      startsAt: options.at ?? new Date(0),
      endsAt: options.endsAt ?? null,
      reason: options.reason ?? "other",
      comment: null,
      notify: options.notify ?? true,
      imposedBy: null,
      liftedAt: null,
      liftedBy: null,
      liftComment: null,
      settledAt: null,
    };
    this.rows.push(row);
    return row;
  }
}

function active(row: RestrictionRow, at: Date): boolean {
  return row.liftedAt === null && (row.endsAt === null || row.endsAt.getTime() > at.getTime());
}

/** Сообщения соседним репликам в тестах никуда не уходят — их считаем. */
export interface FakePublisher {
  published: string[];
}

/** Порт «можно ли» поверх памяти; без Redis — сброс кеша остаётся на этой реплике. */
export function restrictionsGate(repository = new MemoryRestrictionsRepository()): AccountRestrictions & FakePublisher {
  const published: string[] = [];
  const redis = {
    publish: async (_channel: string, message: string) => {
      published.push(message);
      return 1;
    },
    // Подписка соседних реплик — без настоящего Redis она просто есть.
    duplicate: () => ({ on: () => undefined, subscribe: async () => 1, disconnect: () => undefined }),
  } as unknown as Redis;
  const gate = new AccountRestrictions(repository, redis, loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv));
  return Object.assign(gate, { published });
}
