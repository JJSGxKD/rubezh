import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { DONATION_PRODUCT } from "../payments/purchase-types.js";
import { CONVERSION_WINDOWS } from "./conversion-rules.js";
import { countedRun } from "./counted-run.js";
import { EVENT_GOAL, type PostbackEvent } from "./postback-events.js";

/**
 * Конверсии по кликам переходника (docs/35-stage4-plan.md Р86, WP43; запросы вынесены из
 * `conversions.repository.ts` в tasks/T-0070).
 *
 * Строки выводятся из фактов, а не из событий: игрок — новый аккаунт, чьё первое касание — клик
 * по ссылке, а забеги и оплаты уже лежат в базе. Повтор прохода ничего не задваивает —
 * регистрацию и первую покупку держит уникальный ключ на клик и назначение, любую покупку — ключ
 * на оплату и назначение. Запуск по прямой ссылке клика не оставляет: его конверсии выводит
 * `direct-launch-sweep.ts`.
 *
 * Кому и что отправлять, решает набор назначений (`destinations/destination-targets.ts`): запросы
 * берут из него ссылки, события и момент, с которого клики учитываются.
 */

/**
 * Дописать регистрации и покупки по кликам. `targets` — набор назначений прохода. Возвращает,
 * сколько строк вставлено.
 */
export async function sweepClickLaunches(prisma: PrismaClient, now: Date, targets: Prisma.Sql): Promise<{ registrations: number; purchases: number }> {
  const { registrationDays, purchaseDays, purchaseSettleMin } = CONVERSION_WINDOWS;
  const registration: PostbackEvent = "registration";
  const first: PostbackEvent = "purchase_first";
  const repeat: PostbackEvent = "purchase_repeat";
  // Кандидаты — по первому касанию за окно: индекс `(first_start_kind, first_at)`.
  // Аккаунт команды конверсией не становится: свои проверки сети не нужны —
  // строка пишется пропущенной, отправить её можно руками. В `network` —
  // имя назначения: колонка обязательна и нужна коду прошлого релиза.
  const registrations = await prisma.$executeRaw`
      WITH ${targets}
      INSERT INTO ad_conversion (conversion_id, network, destination, link_code, click_id, account_id, goal, status, reason, next_attempt_at, created_at)
      SELECT gen_random_uuid(), t.destination, t.destination, l.code, c.click_id, q.account_id, ${EVENT_GOAL.registration}::smallint,
             (CASE WHEN EXISTS (SELECT 1 FROM account_role r WHERE r.account_id = q.account_id) THEN 'skipped' ELSE 'pending' END)::ad_conversion_status,
             CASE WHEN EXISTS (SELECT 1 FROM account_role r WHERE r.account_id = q.account_id) THEN 'team' END,
             ${now}, ${now}
      FROM targets t
      JOIN link l ON l.code = t.link_code
      JOIN link_click c ON c.link_code = l.code
      JOIN acquisition q ON q.first_start_ref = c.click_id
      JOIN account a ON a.account_id = q.account_id AND a.created_at >= c.at - interval '1 minute'
      WHERE q.first_start_kind = 'click'
        AND q.first_at > ${now}::timestamptz - make_interval(days => ${registrationDays + 1})
        AND ${registration}::text = ANY(t.events)
        AND c.at >= t.since
        AND (
          l.registration_on = 'launch'
          OR EXISTS (
            SELECT 1 FROM run r
            WHERE r.account_id = q.account_id
              AND ${countedRun("r")}
              AND r.finished_at <= c.at + make_interval(days => ${registrationDays})
          )
        )
      ON CONFLICT DO NOTHING`;

  // Покупки — настоящие, не возвращённые, отлежавшиеся. Номер покупки —
  // среди таких же по времени оплаты: первая — цель 2, остальные — 3. Номер
  // считается по всем оплатам аккаунта, а не по назначению: «первая» для
  // назначения без повторных покупок не должна стать второй оплатой.
  const purchases = await prisma.$executeRaw`
      WITH ${targets},
      attributed AS (
        SELECT q.account_id, c.click_id, c.at AS click_at, l.code AS link_code, t.destination, t.events
        FROM targets t
        JOIN link l ON l.code = t.link_code
        JOIN link_click c ON c.link_code = l.code
        JOIN acquisition q ON q.first_start_ref = c.click_id
        JOIN account a ON a.account_id = q.account_id AND a.created_at >= c.at - interval '1 minute'
        WHERE q.first_start_kind = 'click'
          AND q.first_at > ${now}::timestamptz - make_interval(days => ${purchaseDays + 1})
          AND c.at >= t.since
      ),
      paid AS (
        SELECT p.purchase_id, p.account_id, p.paid_at,
               row_number() OVER (PARTITION BY p.account_id ORDER BY p.paid_at, p.purchase_id) AS n
        FROM purchase p
        WHERE p.account_id IN (SELECT account_id FROM attributed)
          AND p.mode = 'live' AND p.product::text <> ${DONATION_PRODUCT} AND p.paid_at IS NOT NULL AND p.status = 'paid' AND p.refund_requested_at IS NULL
      )
      INSERT INTO ad_conversion (conversion_id, network, destination, link_code, click_id, account_id, goal, purchase_id, status, reason, next_attempt_at, created_at)
      SELECT gen_random_uuid(), t.destination, t.destination, t.link_code, t.click_id, t.account_id,
             (CASE WHEN paid.n = 1 THEN ${EVENT_GOAL.purchase_first} ELSE ${EVENT_GOAL.purchase_repeat} END)::smallint, paid.purchase_id,
             (CASE WHEN EXISTS (SELECT 1 FROM account_role r WHERE r.account_id = t.account_id) THEN 'skipped' ELSE 'pending' END)::ad_conversion_status,
             CASE WHEN EXISTS (SELECT 1 FROM account_role r WHERE r.account_id = t.account_id) THEN 'team' END,
             ${now}, ${now}
      FROM paid
      JOIN attributed t ON t.account_id = paid.account_id
      WHERE paid.paid_at <= t.click_at + make_interval(days => ${purchaseDays})
        AND paid.paid_at <= ${now}::timestamptz - make_interval(mins => ${purchaseSettleMin})
        AND (CASE WHEN paid.n = 1 THEN ${first}::text ELSE ${repeat}::text END) = ANY(t.events)
      ON CONFLICT DO NOTHING`;
  return { registrations, purchases };
}
