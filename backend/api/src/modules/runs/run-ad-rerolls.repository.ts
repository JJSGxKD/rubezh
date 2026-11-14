import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * Книга рекламных перебросов карточек (tasks/T-0199, Р133): по строке на
 * забег. `run_id` — первичный ключ, поэтому второй рекламный переброс в том
 * же забеге не записывается, а уникальная `session_id` не даёт потратить одну
 * сессию показа на два забега. Лимиты держит сама запись, а не проверка перед
 * ней: два параллельных забора дают ровно одну строку.
 */

export interface AdRerollGrant {
  runId: string;
  accountId: string;
  sessionId: string;
  /** сеть показа; у пропуска VIP — его имя */
  networkKey: string;
  grantedAt: Date;
}

/**
 * `granted` — записано; `repeat` — та же сессия уже выдала переброс этому
 * забегу, ответ дожимается; `taken` — забег уже перебросил другой сессией или
 * сессия уже потрачена на другой забег.
 */
export type RerollGrantOutcome = "granted" | "repeat" | "taken";

export const RUN_AD_REROLLS_REPOSITORY = Symbol("RUN_AD_REROLLS_REPOSITORY");

export interface RunAdRerollsRepository {
  grant(grant: AdRerollGrant): Promise<RerollGrantOutcome>;
  /** забег, на который уже потрачена сессия; `null` — сессия свободна */
  bySession(sessionId: string): Promise<{ runId: string } | null>;
  /** сколько рекламных перебросов записано у забега: ноль или один */
  count(runId: string): Promise<number>;
}

@Injectable()
export class PrismaRunAdRerollsRepository implements RunAdRerollsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async grant(grant: AdRerollGrant): Promise<RerollGrantOutcome> {
    // Конфликт по любому ключу — забег или сессия заняты. Блокировки аккаунта не нужно: суточного
    // потолка у переброса нет, а конфликт ключей база разрешает сама.
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO run_ad_reroll (run_id, account_id, session_id, network_key, granted_at)
      VALUES (${grant.runId}, ${grant.accountId}::uuid, ${grant.sessionId}, ${grant.networkKey}, ${grant.grantedAt})
      ON CONFLICT DO NOTHING`;
    if (inserted > 0) return "granted";
    // Не вставилось: смотрим, чем занят ключ. Ждавшая чужую вставку запись видит её после её фиксации.
    const spent = await this.bySession(grant.sessionId);
    return spent?.runId === grant.runId ? "repeat" : "taken";
  }

  async bySession(sessionId: string): Promise<{ runId: string } | null> {
    return await this.prisma.runAdReroll.findUnique({ where: { sessionId }, select: { runId: true } });
  }

  async count(runId: string): Promise<number> {
    return await this.prisma.runAdReroll.count({ where: { runId } });
  }
}
