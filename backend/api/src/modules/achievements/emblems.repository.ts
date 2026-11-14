import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { MIN_BOARD } from "../seasons/season-rules.js";
import { ACHIEVEMENT_PERIOD_START } from "../tasks/tasks.repository.js";
import { EMBLEM_IDS, EXTERNAL_ROLES, PARTNER_EMBLEM_STATUS, PARTNER_ROLE, SEASON_STEPS } from "./emblem-rules.js";

/**
 * Хранилище знаков у имени (tasks/T-0235). Каждый запрос берёт список аккаунтов целиком
 * одним обращением к базе — рейтинг, сезон и друзья спрашивают знаки пачкой, а не по строке.
 * Каталог знаков (названия, редкость) читает модуль заданий: здесь только то, что известно
 * об аккаунте.
 *
 * Правила знаков продублированы в SQL проходом редкости (`emblemHoldersSql`): он считает
 * держателей по всем игрокам разом. Совпадение двух записей проверяет интеграционный тест.
 */

/** Что аккаунт сам знает о статусных знаках и выбранном знаке. */
export interface AccountEmblemRow {
  testerAt: Date | null;
  supporterAt: Date | null;
  /** есть роль команды (внешние роли не в счёт) */
  hasRole: boolean;
  /** роль `partner` и карточка партнёра этого аккаунта в статусе `active` */
  partnerActive: boolean;
  shownEmblemId: string | null;
}

/** Итоги закрытых сезонов аккаунта, достаточных по размеру таблицы. */
export interface SeasonStanding {
  /** лучшее место за все такие сезоны */
  bestPlace: number;
  /** id сезонного знака → порядковый номер последнего сезона, где порог взят */
  seasons: Map<string, number>;
}

export const EMBLEMS_REPOSITORY = Symbol("EMBLEMS_REPOSITORY");

export interface EmblemsRepository {
  /** Игрок, тестер и меценат, роль, выбранный знак — по списку аккаунтов; нет в базе — нет и в карте. */
  statuses(accountIds: readonly string[]): Promise<Map<string, AccountEmblemRow>>;
  /** Конец VIP — самый поздний конец периода; у не имевшего VIP записи нет. */
  vipUntil(accountIds: readonly string[]): Promise<Map<string, Date>>;
  /** Итоги сезонов; у не попавшего ни в один достаточный сезон записи нет. */
  standings(accountIds: readonly string[]): Promise<Map<string, SeasonStanding>>;
  /** id выполненных достижений со знаком (`emblem_tier` не пуст) по каждому аккаунту. */
  merit(accountIds: readonly string[]): Promise<Map<string, Set<string>>>;
  /** Записать выбранный знак; `false` — там уже стояло то же, и ничего не записано. */
  setShown(accountId: string, emblemId: string | null): Promise<boolean>;
}

const statusSchema = z.object({
  account_id: z.string(),
  tester_at: z.date().nullable(),
  supporter_at: z.date().nullable(),
  shown_emblem_id: z.string().nullable(),
  has_role: z.boolean(),
  partner_active: z.boolean(),
});
const vipSchema = z.object({ account_id: z.string(), until: z.date() });
const standingSchema = z.object({
  account_id: z.string(),
  best_place: z.number().int(),
  champion_season: z.number().int().nullable(),
  top10_season: z.number().int().nullable(),
  top100_season: z.number().int().nullable(),
});
const meritSchema = z.object({ account_id: z.string(), task_id: z.string() });

@Injectable()
export class PrismaEmblemsRepository implements EmblemsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async statuses(accountIds: readonly string[]): Promise<Map<string, AccountEmblemRow>> {
    const result = new Map<string, AccountEmblemRow>();
    if (accountIds.length === 0) return result;
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT a.account_id::text AS account_id, a.tester_at, a.supporter_at, a.shown_emblem_id,
             EXISTS (SELECT 1 FROM account_role r WHERE r.account_id = a.account_id AND r.role::text <> ALL(${[...EXTERNAL_ROLES]}::text[])) AS has_role,
             EXISTS (
               SELECT 1 FROM partner p
               JOIN account_role r ON r.account_id = p.account_id AND r.role::text = ${PARTNER_ROLE}
               WHERE p.account_id = a.account_id AND p.status = ${PARTNER_EMBLEM_STATUS}
             ) AS partner_active
      FROM account a
      WHERE a.account_id = ANY(${[...accountIds]}::uuid[])`;
    for (const raw of rows) {
      const row = statusSchema.parse(raw);
      result.set(row.account_id, {
        testerAt: row.tester_at,
        supporterAt: row.supporter_at,
        hasRole: row.has_role,
        partnerActive: row.partner_active,
        shownEmblemId: row.shown_emblem_id,
      });
    }
    return result;
  }

  async vipUntil(accountIds: readonly string[]): Promise<Map<string, Date>> {
    const result = new Map<string, Date>();
    if (accountIds.length === 0) return result;
    // Конец VIP — самый поздний конец периода: тем же способом его читает `VipRepository.until`.
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT account_id::text AS account_id, max(ends_at) AS until
      FROM vip_period
      WHERE account_id = ANY(${[...accountIds]}::uuid[])
      GROUP BY account_id`;
    for (const raw of rows) {
      const row = vipSchema.parse(raw);
      result.set(row.account_id, row.until);
    }
    return result;
  }

  async standings(accountIds: readonly string[]): Promise<Map<string, SeasonStanding>> {
    const result = new Map<string, SeasonStanding>();
    if (accountIds.length === 0) return result;
    const [champion, top10, top100] = SEASON_STEPS;
    // Места награждаются только на таблице не меньше `MIN_BOARD` (как лестница наград сезона). Для
    // каждого порога — последний сезон, где он взят; номер сезона — сколько закрытых сезонов не позже.
    const rows = await this.prisma.$queryRaw<unknown[]>`
      WITH best AS (
        SELECT r.account_id,
               min(r.place) AS best_place,
               max(r.season_key) FILTER (WHERE r.place <= ${champion.maxPlace}) AS champion_key,
               max(r.season_key) FILTER (WHERE r.place <= ${top10.maxPlace}) AS top10_key,
               max(r.season_key) FILTER (WHERE r.place <= ${top100.maxPlace}) AS top100_key
        FROM season_result r
        WHERE r.account_id = ANY(${[...accountIds]}::uuid[]) AND r.board_size >= ${MIN_BOARD}
        GROUP BY r.account_id
      )
      SELECT b.account_id::text AS account_id, b.best_place::int AS best_place,
             CASE WHEN b.champion_key IS NULL THEN NULL ELSE (SELECT count(*)::int FROM season s WHERE s.season_key <= b.champion_key) END AS champion_season,
             CASE WHEN b.top10_key IS NULL THEN NULL ELSE (SELECT count(*)::int FROM season s WHERE s.season_key <= b.top10_key) END AS top10_season,
             CASE WHEN b.top100_key IS NULL THEN NULL ELSE (SELECT count(*)::int FROM season s WHERE s.season_key <= b.top100_key) END AS top100_season
      FROM best b`;
    for (const raw of rows) {
      const row = standingSchema.parse(raw);
      const seasons = new Map<string, number>();
      if (row.champion_season !== null) seasons.set(champion.id, row.champion_season);
      if (row.top10_season !== null) seasons.set(top10.id, row.top10_season);
      if (row.top100_season !== null) seasons.set(top100.id, row.top100_season);
      result.set(row.account_id, { bestPlace: row.best_place, seasons });
    }
    return result;
  }

  async merit(accountIds: readonly string[]): Promise<Map<string, Set<string>>> {
    const result = new Map<string, Set<string>>();
    if (accountIds.length === 0) return result;
    // Прогресса у статусных и сезонных знаков нет; строка с таким id, откуда бы она ни взялась, знака не даёт.
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT p.account_id::text AS account_id, p.task_id
      FROM task_progress p
      JOIN task_def d ON d.task_id = p.task_id AND d.period = 'achievement' AND d.emblem_tier IS NOT NULL AND d.kind NOT IN ('status', 'season')
      WHERE p.account_id = ANY(${[...accountIds]}::uuid[]) AND p.period_start = ${ACHIEVEMENT_PERIOD_START}::date AND p.completed_at IS NOT NULL`;
    for (const raw of rows) {
      const row = meritSchema.parse(raw);
      const held = result.get(row.account_id) ?? new Set<string>();
      held.add(row.task_id);
      result.set(row.account_id, held);
    }
    return result;
  }

  async setShown(accountId: string, emblemId: string | null): Promise<boolean> {
    // Повтор того же выбора строку не трогает: условие в самом запросе, а не чтение перед записью.
    const changed = await this.prisma.$executeRaw`
      UPDATE account SET shown_emblem_id = ${emblemId}
      WHERE account_id = ${accountId}::uuid AND shown_emblem_id IS DISTINCT FROM ${emblemId}`;
    return changed > 0;
  }
}

/**
 * Держатели статусных и сезонных знаков среди игроков с забегом — кусок прохода редкости
 * (`AchievementsRepository.recomputeRarity`, tasks/T-0106, T-0235, T-0480). Подставляется в `WITH`
 * после выражения `pop (account_id)` — населения прохода, — и отдаёт строки `(task_id, holders)` по
 * одной на знак: VIP, Тестер, Меценат, Команда, Партнёр и три сезонных. Те же правила, что у
 * `heldStatus` и `heldSeason`; VIP считается на момент прохода.
 */
export function emblemHoldersSql(now: Date): Prisma.Sql {
  const [champion, top10, top100] = SEASON_STEPS;
  return Prisma.sql`
    SELECT ${EMBLEM_IDS.vip}::text AS task_id, count(*)::int AS holders
    FROM pop WHERE EXISTS (SELECT 1 FROM vip_period v WHERE v.account_id = pop.account_id AND v.ends_at > ${now}::timestamptz)
    UNION ALL
    SELECT ${EMBLEM_IDS.tester}::text, count(*)::int
    FROM pop JOIN account a ON a.account_id = pop.account_id WHERE a.tester_at IS NOT NULL
    UNION ALL
    SELECT ${EMBLEM_IDS.supporter}::text, count(*)::int
    FROM pop JOIN account a ON a.account_id = pop.account_id WHERE a.supporter_at IS NOT NULL
    UNION ALL
    SELECT ${EMBLEM_IDS.team}::text, count(*)::int
    FROM pop WHERE EXISTS (SELECT 1 FROM account_role r WHERE r.account_id = pop.account_id AND r.role::text <> ALL(${[...EXTERNAL_ROLES]}::text[]))
    UNION ALL
    SELECT ${EMBLEM_IDS.partner}::text, count(*)::int
    FROM pop WHERE EXISTS (
      SELECT 1 FROM partner p
      JOIN account_role r ON r.account_id = p.account_id AND r.role::text = ${PARTNER_ROLE}
      WHERE p.account_id = pop.account_id AND p.status = ${PARTNER_EMBLEM_STATUS}
    )
    UNION ALL
    SELECT step.id AS task_id, count(*) FILTER (WHERE standing.best_place <= step.max_place)::int AS holders
    FROM (VALUES (${champion.id}::text, ${champion.maxPlace}::int), (${top10.id}::text, ${top10.maxPlace}::int), (${top100.id}::text, ${top100.maxPlace}::int)) AS step (id, max_place)
    CROSS JOIN (
      SELECT min(r.place) AS best_place FROM season_result r JOIN pop ON pop.account_id = r.account_id WHERE r.board_size >= ${MIN_BOARD} GROUP BY r.account_id
    ) AS standing
    GROUP BY step.id`;
}
