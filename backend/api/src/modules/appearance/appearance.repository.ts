import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { ACHIEVEMENT_PERIOD_START } from "../tasks/tasks.repository.js";

/**
 * Хранилище обликов (tasks/T-0237). Каждый запрос берёт список аккаунтов целиком одним
 * обращением к базе — рейтинг, сезон и друзья спрашивают облики пачкой, а не по строке. VIP и
 * лучшее место в сезоне читает репозиторий знаков (`emblems.repository.ts`, T-0235): запросы не
 * копируются, сервис собирает все источники сам.
 */

/** Что аккаунт сам знает об облике: выбор, кружок аватара и уровень. */
export interface AccountAppearanceRow {
  /** сохранённый выбор; пусто — не выбирал */
  appearanceId: string | null;
  avatarPhoto: boolean;
  level: number;
}

export const APPEARANCE_REPOSITORY = Symbol("APPEARANCE_REPOSITORY");

export interface AppearanceRepository {
  /** Выбор, кружок аватара и уровень — по списку аккаунтов; нет в базе — нет и в карте. */
  accounts(accountIds: readonly string[]): Promise<Map<string, AccountAppearanceRow>>;
  /** Какие из достижений `taskIds` выполнены, по каждому аккаунту; у не выполнившего записи нет. */
  completed(accountIds: readonly string[], taskIds: readonly string[]): Promise<Map<string, Set<string>>>;
  /** Кто хоть раз забрал ступень очков недели в `points`. */
  weeklyClaimed(accountIds: readonly string[], points: number): Promise<Set<string>>;
  /**
   * Записать выбор; поле, которого нет, не трогается. `false` — там уже стояло то же, и
   * ничего не записано.
   */
  setChoice(accountId: string, choice: { appearanceId?: string; avatarPhoto?: boolean }): Promise<boolean>;
}

const accountSchema = z.object({
  account_id: z.string(),
  appearance_id: z.string().nullable(),
  avatar_photo: z.boolean(),
  level: z.number().int(),
});
const completedSchema = z.object({ account_id: z.string(), task_id: z.string() });
const claimedSchema = z.object({ account_id: z.string() });

@Injectable()
export class PrismaAppearanceRepository implements AppearanceRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async accounts(accountIds: readonly string[]): Promise<Map<string, AccountAppearanceRow>> {
    const result = new Map<string, AccountAppearanceRow>();
    if (accountIds.length === 0) return result;
    // Строки прогресса может не быть у только что созданного аккаунта: он на первом уровне.
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT a.account_id::text AS account_id, a.appearance_id, a.avatar_photo, COALESCE(p.level, 1)::int AS level
      FROM account a
      LEFT JOIN account_progress p ON p.account_id = a.account_id
      WHERE a.account_id = ANY(${[...accountIds]}::uuid[])`;
    for (const raw of rows) {
      const row = accountSchema.parse(raw);
      result.set(row.account_id, { appearanceId: row.appearance_id, avatarPhoto: row.avatar_photo, level: row.level });
    }
    return result;
  }

  async completed(accountIds: readonly string[], taskIds: readonly string[]): Promise<Map<string, Set<string>>> {
    const result = new Map<string, Set<string>>();
    if (accountIds.length === 0 || taskIds.length === 0) return result;
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT account_id::text AS account_id, task_id
      FROM task_progress
      WHERE account_id = ANY(${[...accountIds]}::uuid[])
        AND task_id = ANY(${[...taskIds]}::text[])
        AND period_start = ${ACHIEVEMENT_PERIOD_START}::date
        AND completed_at IS NOT NULL`;
    for (const raw of rows) {
      const row = completedSchema.parse(raw);
      const done = result.get(row.account_id) ?? new Set<string>();
      done.add(row.task_id);
      result.set(row.account_id, done);
    }
    return result;
  }

  async weeklyClaimed(accountIds: readonly string[], points: number): Promise<Set<string>> {
    if (accountIds.length === 0) return new Set<string>();
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT DISTINCT account_id::text AS account_id
      FROM task_points_claim
      WHERE account_id = ANY(${[...accountIds]}::uuid[]) AND period = 'weekly' AND points = ${points}`;
    return new Set(rows.map((raw) => claimedSchema.parse(raw).account_id));
  }

  async setChoice(accountId: string, choice: { appearanceId?: string; avatarPhoto?: boolean }): Promise<boolean> {
    const appearanceId = choice.appearanceId ?? null;
    const avatarPhoto = choice.avatarPhoto ?? null;
    // Повтор того же выбора строку не трогает: условие в самом запросе, а не чтение перед записью.
    // Поле, которого в выборе нет (`NULL`), остаётся как было.
    const changed = await this.prisma.$executeRaw`
      UPDATE account
      SET appearance_id = COALESCE(${appearanceId}::varchar, appearance_id),
          avatar_photo = COALESCE(${avatarPhoto}::boolean, avatar_photo)
      WHERE account_id = ${accountId}::uuid
        AND (appearance_id IS DISTINCT FROM COALESCE(${appearanceId}::varchar, appearance_id)
          OR avatar_photo IS DISTINCT FROM COALESCE(${avatarPhoto}::boolean, avatar_photo))`;
    return changed > 0;
  }
}
