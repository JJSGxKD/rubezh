import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
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
 *
 * Возвраты на следующий день (T-0071) бывают только у клика: у прямого запуска нет ни клика, ни
 * адреса, куда их отправлять, а AdsGram их не принимает.
 */

/** Сколько строк вставил каждый из запросов: регистрации, покупки, возвраты на следующий день. */
export interface ClickSweep {
  registrations: number;
  purchases: number;
  returns: number;
}

/** Литерал вместо параметра: по нему планировщик подбирает частичный уникальный индекс на цели 1, 2, 4. */
const RETURN_GOAL = Prisma.raw(String(EVENT_GOAL.d1_return));

/**
 * Дописать регистрации, покупки и возвраты по кликам. `targets` — набор назначений прохода. Возвращает,
 * сколько строк вставлено.
 */
export async function sweepClickLaunches(prisma: PrismaClient, now: Date, targets: Prisma.Sql): Promise<ClickSweep> {
  const { registrationDays, returnLookbackDays, purchaseDays, purchaseSettleMin } = CONVERSION_WINDOWS;
  const returned: PostbackEvent = "d1_return";
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

  // Возвраты на следующий день: засчитанный забег в игровые сутки (полночь по Москве, `GAME_DAY_TIME_ZONE`) сразу
  // за днём регистрации. День регистрации — день первого засчитанного забега, а не создания аккаунта, и этот забег
  // обязан уложиться в окно регистрации от клика: иначе регистрации не было и возвращаться не к чему. Сутки
  // считаются границами — `[полночь дня + 1, полночь дня + 2)` — а не сравнением дат: так работает индекс забегов
  // аккаунта `(account_id, finished_at)`. Кандидаты — по первому касанию за окно просмотра (индекс
  // `(first_start_kind, first_at)`); назначения без `d1_return` отсекает `ANY(t.events)` до обращения к забегам, а
  // уже заведённые — `NOT EXISTS` по уникальному индексу, чтобы раз в минуту не пересчитывать забеги тех, кому всё
  // отправлено. Игровые сутки считает база: она же хранит время забегов.
  const returns = await prisma.$executeRaw`
      WITH ${targets}
      INSERT INTO ad_conversion (conversion_id, network, destination, link_code, click_id, account_id, goal, status, reason, next_attempt_at, created_at)
      SELECT gen_random_uuid(), t.destination, t.destination, l.code, c.click_id, q.account_id, ${EVENT_GOAL.d1_return}::smallint,
             (CASE WHEN EXISTS (SELECT 1 FROM account_role r WHERE r.account_id = q.account_id) THEN 'skipped' ELSE 'pending' END)::ad_conversion_status,
             CASE WHEN EXISTS (SELECT 1 FROM account_role r WHERE r.account_id = q.account_id) THEN 'team' END,
             ${now}, ${now}
      FROM targets t
      JOIN link l ON l.code = t.link_code
      JOIN link_click c ON c.link_code = l.code
      JOIN acquisition q ON q.first_start_ref = c.click_id
      JOIN account a ON a.account_id = q.account_id AND a.created_at >= c.at - interval '1 minute'
      JOIN LATERAL (
        SELECT (min(f.finished_at) AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date AS day
        FROM run f
        WHERE f.account_id = q.account_id
          AND ${countedRun("f")}
          AND f.finished_at <= c.at + make_interval(days => ${registrationDays})
      ) reg ON reg.day IS NOT NULL
      WHERE q.first_start_kind = 'click'
        AND q.first_at > ${now}::timestamptz - make_interval(days => ${returnLookbackDays})
        AND ${returned}::text = ANY(t.events)
        AND c.at >= t.since
        AND NOT EXISTS (SELECT 1 FROM ad_conversion v WHERE v.click_id = c.click_id AND v.goal = ${RETURN_GOAL} AND v.destination = t.destination)
        AND EXISTS (
          SELECT 1 FROM run r
          WHERE r.account_id = q.account_id
            AND ${countedRun("r")}
            AND r.finished_at >= ((reg.day + 1)::timestamp AT TIME ZONE ${GAME_DAY_TIME_ZONE})
            AND r.finished_at < ((reg.day + 2)::timestamp AT TIME ZONE ${GAME_DAY_TIME_ZONE})
        )
      ON CONFLICT DO NOTHING`;
  return { registrations, purchases, returns };
}
