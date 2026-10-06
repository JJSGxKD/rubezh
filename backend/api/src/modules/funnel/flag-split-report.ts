import { z } from "zod";
import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { FlagRule } from "../flags/flag-rollout.js";

/**
 * Доля флага против остальных (docs/35-stage4-plan.md WP12, часть 10b): то,
 * по чему решают, оставить ли выкаченное, — межстраничную прежде всего.
 * Когорта — игроки, впервые открывшие приложение за период, на площадках
 * флага; доля — та же корзина, что у флага (`flag-rollout.ts`, `bucketOf`),
 * посчитанная базой. Включён ли флаг, не важно: сравнивается доля, которой
 * он включён или был бы включён при нынешних настройках.
 *
 * Возвраты — «скользящие», как в воронке: открыл приложение на первые
 * игровые сутки после первого открытия или позже — D1, на седьмые или позже
 * — D7. Поэтому их доля считается только среди созревших: кто пришёл
 * сегодня, вернуться на D1 ещё не мог, и без этого разница тонула бы в
 * свежих игроках.
 *
 * У числовых показателей — сумма и сумма квадратов по игрокам: панель
 * считает по ним среднее и разброс и проверяет, отличима ли разница от шума.
 */

/** Сумма показателя по игрокам и сумма его квадратов. */
export interface SplitMoment {
  sum: number;
  sumSq: number;
}

export interface FlagSplitGroup {
  players: number;
  /** пришли не позже вчерашних игровых суток — могли вернуться на D1 */
  d1Eligible: number;
  d1Returned: number;
  /** пришли не позже чем семь игровых суток назад */
  d7Eligible: number;
  d7Returned: number;
  /** сделали хотя бы одну настоящую покупку — тестовые не в счёт */
  payers: number;
  /** списанные звёзды по оплаченным настоящим покупкам, без возвратов */
  stars: SplitMoment;
  runs: SplitMoment;
  /** межстраничные на экране */
  interstitials: SplitMoment;
  /** досмотренные ролики за награду — у VIP без ролика их нет */
  rewarded: SplitMoment;
}

export interface FlagSplit {
  /** игроки в доле флага */
  share: FlagSplitGroup;
  /** все остальные на площадках флага */
  rest: FlagSplitGroup;
}

/** Счёты и суммы база отдаёт `bigint`. */
const numeric = z.union([z.number(), z.bigint()]).transform(Number);

const rowSchema = z.object({
  in_share: z.boolean(),
  players: numeric,
  d1_eligible: numeric,
  d1_returned: numeric,
  d7_eligible: numeric,
  d7_returned: numeric,
  payers: numeric,
  stars: numeric,
  stars_sq: numeric,
  runs: numeric,
  runs_sq: numeric,
  interstitials: numeric,
  interstitials_sq: numeric,
  rewarded: numeric,
  rewarded_sq: numeric,
});

const EMPTY: FlagSplitGroup = {
  players: 0,
  d1Eligible: 0,
  d1Returned: 0,
  d7Eligible: 0,
  d7Returned: 0,
  payers: 0,
  stars: { sum: 0, sumSq: 0 },
  runs: { sum: 0, sumSq: 0 },
  interstitials: { sum: 0, sumSq: 0 },
  rewarded: { sum: 0, sumSq: 0 },
};

/**
 * Корзина — первые четыре байта sha256 от «ключ:аккаунт» беззнаковым числом
 * по модулю 100, ровно как `bucketOf`. Суммы по игроку — сгруппированными
 * подзапросами по аккаунтам когорты: каждый идёт своим индексом по
 * `account_id`.
 */
export async function flagSplitReport(prisma: PrismaClient, rule: FlagRule, from: Date, to: Date, at: Date, rewardedPlaces: readonly string[]): Promise<FlagSplit> {
  const rows = await prisma.$queryRawUnsafe<unknown[]>(
    `WITH cohort AS (
       SELECT f.account_id, f.app_opened_at, f.returned_d1_at, f.returned_d7_at, f.first_purchase_at,
              (get_byte(h.digest, 0)::bigint * 16777216 + get_byte(h.digest, 1) * 65536 + get_byte(h.digest, 2) * 256 + get_byte(h.digest, 3)) % 100 < $3 AS in_share,
              (f.app_opened_at AT TIME ZONE $7)::date AS first_day
       FROM account_funnel f
       JOIN account a ON a.account_id = f.account_id
       CROSS JOIN LATERAL (SELECT sha256(convert_to($1 || ':' || f.account_id::text, 'UTF8')) AS digest) h
       WHERE f.app_opened_at >= $4 AND f.app_opened_at < $5
         AND (cardinality($2::text[]) = 0 OR a.platform::text = ANY($2::text[]))
     ),
     purchases AS (
       SELECT account_id, sum(charged_stars)::bigint AS stars FROM purchase
       WHERE mode = 'live' AND status = 'paid' AND account_id IN (SELECT account_id FROM cohort)
       GROUP BY account_id
     ),
     runs AS (
       SELECT account_id, count(*) AS runs FROM run
       WHERE finished_at IS NOT NULL AND account_id IN (SELECT account_id FROM cohort)
       GROUP BY account_id
     ),
     ads AS (
       SELECT account_id,
              count(*) FILTER (WHERE place = 'interstitial' AND shown_at IS NOT NULL) AS interstitials,
              count(*) FILTER (WHERE place = ANY($8::text[]::"AdPlace"[]) AND status IN ('completed', 'claimed') AND block_id IS NOT NULL) AS rewarded
       FROM ad_session WHERE account_id IN (SELECT account_id FROM cohort)
       GROUP BY account_id
     ),
     players AS (
       SELECT c.*, COALESCE(p.stars, 0) AS stars, COALESCE(r.runs, 0) AS runs, COALESCE(s.interstitials, 0) AS interstitials, COALESCE(s.rewarded, 0) AS rewarded
       FROM cohort c
       LEFT JOIN purchases p ON p.account_id = c.account_id
       LEFT JOIN runs r ON r.account_id = c.account_id
       LEFT JOIN ads s ON s.account_id = c.account_id
     )
     SELECT in_share,
            count(*) AS players,
            count(*) FILTER (WHERE first_day <= ($6::timestamptz AT TIME ZONE $7)::date - 1) AS d1_eligible,
            count(*) FILTER (WHERE first_day <= ($6::timestamptz AT TIME ZONE $7)::date - 1 AND returned_d1_at IS NOT NULL) AS d1_returned,
            count(*) FILTER (WHERE first_day <= ($6::timestamptz AT TIME ZONE $7)::date - 7) AS d7_eligible,
            count(*) FILTER (WHERE first_day <= ($6::timestamptz AT TIME ZONE $7)::date - 7 AND returned_d7_at IS NOT NULL) AS d7_returned,
            count(first_purchase_at) AS payers,
            sum(stars)::bigint AS stars, sum(stars * stars)::bigint AS stars_sq,
            sum(runs)::bigint AS runs, sum(runs * runs)::bigint AS runs_sq,
            sum(interstitials)::bigint AS interstitials, sum(interstitials * interstitials)::bigint AS interstitials_sq,
            sum(rewarded)::bigint AS rewarded, sum(rewarded * rewarded)::bigint AS rewarded_sq
     FROM players
     GROUP BY in_share`,
    rule.key,
    [...rule.platforms],
    rule.percent,
    from,
    to,
    at,
    GAME_DAY_TIME_ZONE,
    [...rewardedPlaces],
  );
  const split: FlagSplit = { share: EMPTY, rest: EMPTY };
  for (const raw of rows) {
    const row = rowSchema.parse(raw);
    const group: FlagSplitGroup = {
      players: row.players,
      d1Eligible: row.d1_eligible,
      d1Returned: row.d1_returned,
      d7Eligible: row.d7_eligible,
      d7Returned: row.d7_returned,
      payers: row.payers,
      stars: { sum: row.stars, sumSq: row.stars_sq },
      runs: { sum: row.runs, sumSq: row.runs_sq },
      interstitials: { sum: row.interstitials, sumSq: row.interstitials_sq },
      rewarded: { sum: row.rewarded, sumSq: row.rewarded_sq },
    };
    if (row.in_share) split.share = group;
    else split.rest = group;
  }
  return split;
}
