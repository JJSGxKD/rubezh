import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { parseStartParam } from "../attribution/start-param.js";
import { isLinkNetwork, networkParamsOf } from "../links/link-networks.js";
import { DONATION_PRODUCT } from "../payments/purchase-types.js";
import { CONVERSION_WINDOWS } from "./conversion-rules.js";
import { destinationOf, type DestinationKind } from "./destinations/destination.js";
import { EVENT_GOAL } from "./postback-events.js";

/**
 * Конверсии по запуску прямой ссылки на Mini App (tasks/T-0181, docs/35-stage4-plan.md Р117, Р121).
 *
 * У прямой ссылки клика нет: код ссылки и метки сети едут в стартовом параметре, и сервер видит
 * только запуск — `acquisition.first_start_kind = 'link'`. Правила те же, что у клика
 * (`conversions.repository.ts`): новичок, регистрация после засчитанного забега или при первом
 * запуске, покупки настоящие и отлежавшиеся, окна считаются от первого запуска. Отличия два:
 * `click_id` пуст, а метки сети копируются в `ad_conversion.network_params` — клика, где их можно
 * хранить, нет.
 *
 * Кому и что отправлять, решает набор назначений (`destinations/destination-targets.ts`), как и в
 * проходе по кликам: второй точки, где это решается, нет.
 *
 * Параметр разбирается в TypeScript, а не в SQL: правило разбора одно и живёт в
 * `attribution/start-param.ts`. Повтор и параллельный проход ничего не задваивают: вставка идёт
 * `ON CONFLICT DO NOTHING`, а ключи держат частичный индекс на аккаунт без клика и ключ на оплату.
 */

/** Кандидатов за проход: проход раз в минуту, остальные уйдут со следующим. */
const BATCH = 500;

/** Запуск по прямой ссылке, за который сети положена строка. */
export interface DirectCandidate {
  accountId: string;
  linkCode: string;
  /** сеть ссылки: по её профилю отбираются метки; у ссылки без сети меток нет */
  network: string | null;
  destination: DestinationKind;
  /** код события: 1 — регистрация, 2 — первая покупка, 3 — повторная */
  goal: number;
  /** оплата у целей 2 и 3, у регистрации — `null` */
  purchaseId: string | null;
  /** `first_start_param` аккаунта как записан */
  startParam: string | null;
  /** аккаунт команды: строка пишется пропущенной */
  team: boolean;
}

/** Строка `ad_conversion`, как её пишет прямая ветка. */
export interface DirectRow {
  /** имя назначения: колонка обязательна и нужна коду прошлого релиза */
  network: DestinationKind;
  destination: DestinationKind;
  linkCode: string;
  clickId: null;
  accountId: string;
  goal: number;
  purchaseId: string | null;
  status: "pending" | "skipped";
  reason: "team" | null;
  /** метки сети; `null` — параметр без меток, отправитель пропустит строку как `no_macros` */
  networkParams: Record<string, string> | null;
  nextAttemptAt: Date;
  createdAt: Date;
}

/**
 * Метки из сохранённого параметра: вид `link` с кодом именно этой ссылки, ключи — из профиля сети
 * ссылки, значения — по тем же правилам, что у метки клика.
 */
function labelsOf(candidate: DirectCandidate): Record<string, string> | null {
  if (candidate.network === null || !isLinkNetwork(candidate.network)) return null;
  const parsed = parseStartParam(candidate.startParam, "miniapp");
  if (parsed.kind !== "link" || parsed.ref !== candidate.linkCode) return null;
  return networkParamsOf(candidate.network, parsed.networkParams ?? {});
}

/**
 * Строки по кандидатам. Метки нет — строка всё равно пишется: иначе кандидат выбирался бы заново
 * каждый проход, а в журнале не было бы видно, что запуск не принёс меток.
 */
export function directConversionRows(candidates: readonly DirectCandidate[], now: Date): DirectRow[] {
  return candidates.map((candidate) => ({
    network: candidate.destination,
    destination: candidate.destination,
    linkCode: candidate.linkCode,
    clickId: null,
    accountId: candidate.accountId,
    goal: candidate.goal,
    purchaseId: candidate.purchaseId,
    status: candidate.team ? "skipped" : "pending",
    reason: candidate.team ? "team" : null,
    networkParams: labelsOf(candidate),
    nextAttemptAt: now,
    createdAt: now,
  }));
}

interface CandidateRow {
  account_id: string;
  link_code: string;
  network: string | null;
  destination: string;
  first_start_param: string | null;
  team: boolean;
}

interface PurchaseCandidateRow extends CandidateRow {
  purchase_id: string;
  /** номер оплаты среди оплат аккаунта: 1 — первая */
  n: number;
}

function candidateOf(row: CandidateRow, goal: number, purchaseId: string | null): DirectCandidate {
  return {
    accountId: row.account_id,
    linkCode: row.link_code,
    network: row.network,
    destination: destinationOf(row.destination),
    goal,
    purchaseId,
    startParam: row.first_start_param,
    team: row.team,
  };
}

async function insert(prisma: PrismaClient, rows: readonly DirectRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const { count } = await prisma.adConversion.createMany({
    data: rows.map(({ networkParams, ...row }) => ({ ...row, ...(networkParams === null ? {} : { networkParams }) })),
    skipDuplicates: true,
  });
  return count;
}

/**
 * Дописать регистрации и покупки по запускам прямых ссылок. `targets` — тот же набор назначений,
 * что у прохода по кликам. Возвращает, сколько строк вставлено.
 */
export async function sweepDirectLaunches(prisma: PrismaClient, now: Date, targets: Prisma.Sql): Promise<{ registrations: number; purchases: number }> {
  const { registrationDays, purchaseDays, purchaseSettleMin, minRunSec } = CONVERSION_WINDOWS;
  const registration = "registration";
  const first = "purchase_first";
  const repeat = "purchase_repeat";

  // Кандидаты — по первому касанию за окно: индекс `(first_start_kind, first_at)`. Цель ссылки в отборе
  // не участвует: запуск по `startapp` доказал, что игрок пришёл по ссылке, а цель потом меняется.
  const registrationRows = await prisma.$queryRaw<CandidateRow[]>`
    WITH ${targets}
    SELECT q.account_id, l.code AS link_code, l.network, t.destination, q.first_start_param,
           EXISTS (SELECT 1 FROM account_role r WHERE r.account_id = q.account_id) AS team
    FROM acquisition q
    JOIN link l ON l.code = q.first_start_ref
    JOIN targets t ON t.link_code = l.code
    JOIN account a ON a.account_id = q.account_id AND a.created_at >= q.first_at - interval '1 minute'
    WHERE q.first_start_kind = 'link'
      AND q.first_at > ${now}::timestamptz - make_interval(days => ${registrationDays + 1})
      AND ${registration}::text = ANY(t.events)
      AND q.first_at >= t.since
      AND NOT EXISTS (SELECT 1 FROM ad_conversion v WHERE v.account_id = q.account_id AND v.goal = ${EVENT_GOAL.registration}::smallint AND v.destination = t.destination)
      AND (
        l.registration_on = 'launch'
        OR EXISTS (
          SELECT 1 FROM run r
          WHERE r.account_id = q.account_id
            AND r.finished_at IS NOT NULL
            AND r.finished_at <= q.first_at + make_interval(days => ${registrationDays})
            AND r.cheats = false
            AND r.survival_sec >= ${minRunSec}
            AND (r.verdict IS NULL OR r.verdict <> 'rejected')
        )
      )
    ORDER BY q.first_at, q.account_id, t.destination
    LIMIT ${BATCH}`;
  const registrations = await insert(prisma, directConversionRows(registrationRows.map((row) => candidateOf(row, EVENT_GOAL.registration, null)), now));

  // Покупки — настоящие, не возвращённые, отлежавшиеся. Номер покупки считается среди всех таких
  // оплат аккаунта и **до** отбора уже заведённых: иначе после отправки первой вторая стала бы «первой».
  const purchaseRows = await prisma.$queryRaw<PurchaseCandidateRow[]>`
    WITH ${targets},
    attributed AS (
      SELECT q.account_id, q.first_at, l.code AS link_code, l.network, t.destination, t.events, q.first_start_param,
             EXISTS (SELECT 1 FROM account_role r WHERE r.account_id = q.account_id) AS team
      FROM acquisition q
      JOIN link l ON l.code = q.first_start_ref
      JOIN targets t ON t.link_code = l.code
      JOIN account a ON a.account_id = q.account_id AND a.created_at >= q.first_at - interval '1 minute'
      WHERE q.first_start_kind = 'link'
        AND q.first_at > ${now}::timestamptz - make_interval(days => ${purchaseDays + 1})
        AND q.first_at >= t.since
    ),
    paid AS (
      SELECT p.purchase_id, p.account_id, p.paid_at,
             (row_number() OVER (PARTITION BY p.account_id ORDER BY p.paid_at, p.purchase_id))::int AS n
      FROM purchase p
      WHERE p.account_id IN (SELECT account_id FROM attributed)
        AND p.mode = 'live' AND p.product::text <> ${DONATION_PRODUCT} AND p.paid_at IS NOT NULL AND p.status = 'paid' AND p.refund_requested_at IS NULL
    )
    SELECT t.account_id, t.link_code, t.network, t.destination, t.first_start_param, t.team, paid.purchase_id, paid.n
    FROM paid
    JOIN attributed t ON t.account_id = paid.account_id
    WHERE paid.paid_at <= t.first_at + make_interval(days => ${purchaseDays})
      AND paid.paid_at <= ${now}::timestamptz - make_interval(mins => ${purchaseSettleMin})
      AND (CASE WHEN paid.n = 1 THEN ${first}::text ELSE ${repeat}::text END) = ANY(t.events)
      AND NOT EXISTS (SELECT 1 FROM ad_conversion v WHERE v.purchase_id = paid.purchase_id AND v.destination = t.destination)
    ORDER BY paid.paid_at, paid.purchase_id, t.destination
    LIMIT ${BATCH}`;
  const purchases = await insert(
    prisma,
    directConversionRows(
      purchaseRows.map((row) => candidateOf(row, row.n === 1 ? EVENT_GOAL.purchase_first : EVENT_GOAL.purchase_repeat, row.purchase_id)),
      now,
    ),
  );
  return { registrations, purchases };
}

/**
 * Обнулить метки конверсий старше окна: у прямого запуска они лежат на самой строке, а не на клике.
 * Повторы отправки живут не дольше двух суток, поэтому 31 сутки от создания строки — с запасом.
 * Отбор — по частичному индексу `ad_conversion_network_params_created_at_idx`. Сколько обнулено.
 */
export async function purgeDirectParams(prisma: PrismaClient, now: Date, limit: number): Promise<number> {
  return await prisma.$executeRaw`
    UPDATE ad_conversion SET network_params = NULL
    WHERE conversion_id IN (
      SELECT conversion_id FROM ad_conversion
      WHERE network_params IS NOT NULL AND created_at < ${now}::timestamptz - make_interval(days => ${CONVERSION_WINDOWS.paramsKeepDays})
      LIMIT ${limit}
    )`;
}
