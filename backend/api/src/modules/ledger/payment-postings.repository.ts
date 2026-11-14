import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { PostablePurchase, PostedState } from "./payment-postings.js";

/**
 * Что в `purchase` ещё не отражено в журнале (docs/37-accounting.md §8; Р219, tasks/T-0458): три выборки с
 * антисоединением по ключу источника проводки `ledger_entry.source_key` (уникальный индекс), каждая — одним
 * запросом и не больше `limit` строк. Покупка приходит вместе с тем, что по ней уже проведено, поэтому решение
 * о проводках не зависит от того, какой из трёх выборок она найдена.
 *
 * Выборки идут по курсору `(время, id)`: покупка, которую не удаётся провести, остаётся в выборке навсегда, и без
 * курсора первые `limit` таких покупок запирали бы всю очередь за собой.
 */

/**
 * - `unpaid` — живые оплаты без проводки оплаты, по времени оплаты;
 * - `unreleased` — проведённые оплаты, срок выхода из холда которых (`meta.releaseAt`) наступил, а выхода нет и
 *   не будет возврата раньше срока, по сроку;
 * - `unrefunded` — возвращённые покупки без проводки возврата, по времени возврата.
 */
export type PostingStream = "unpaid" | "unreleased" | "unrefunded";

export interface StreamCursor {
  at: Date;
  purchaseId: string;
}

export interface PostingCandidate {
  purchase: PostablePurchase;
  posted: PostedState;
}

export const PAYMENT_POSTINGS_REPOSITORY = Symbol("PAYMENT_POSTINGS_REPOSITORY");

export interface PaymentPostingsRepository {
  /** До `limit` покупок выборки строго после курсора, по возрастанию `(время, id)`. */
  candidates(stream: PostingStream, now: Date, after: StreamCursor | null, limit: number): Promise<PostingCandidate[]>;
}

/** Ключ порядка выборки у строки: по нему берётся следующий курсор. */
export function cursorOf(stream: PostingStream, candidate: PostingCandidate): StreamCursor {
  const { purchase, posted } = candidate;
  const at = stream === "unpaid" ? purchase.paidAt : stream === "unrefunded" ? purchase.refundedAt : (posted.paid?.releaseAt ?? null);
  if (at === null) throw new Error(`Выборка «${stream}» вернула покупку ${purchase.purchaseId} без времени для курсора`);
  return { at, purchaseId: purchase.purchaseId };
}

const rowsSchema = z.array(
  z.object({
    purchaseId: z.string().min(1),
    product: z.enum(["continue_run", "shop_item", "vip", "donation"]),
    stars: z.number().int(),
    paidAt: z.coerce.date(),
    refundedAt: z.coerce.date().nullable(),
    platform: z.string().min(1),
    paidPosted: z.boolean(),
    releaseAt: z.coerce.date().nullable(),
    releasePosted: z.boolean(),
    refundPosted: z.boolean(),
  }),
);

/**
 * Живые оплаты, три ключа проводок слева и срок выхода из холда из проводки оплаты. Срок читается только из
 * ISO-строки: запись, сделанная не нашим кодом, с неразборчивым значением обвалила бы приведение типа, а вместе с
 * ним — всю выборку и всю сверку.
 */
const BASE = Prisma.sql`
  SELECT p.purchase_id::text AS "purchaseId",
         p.product::text AS product,
         p.charged_stars AS stars,
         p.paid_at AS "paidAt",
         p.refunded_at AS "refundedAt",
         a.platform::text AS platform,
         (pe.entry_id IS NOT NULL) AS "paidPosted",
         CASE WHEN pe.meta->>'releaseAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$' THEN (pe.meta->>'releaseAt')::timestamptz END AS "releaseAt",
         (rl.entry_id IS NOT NULL) AS "releasePosted",
         (rf.entry_id IS NOT NULL) AS "refundPosted"
  FROM purchase p
  JOIN account a ON a.account_id = p.account_id
  LEFT JOIN ledger_entry pe ON pe.source_key = 'purchase:' || p.purchase_id::text || ':paid'
  LEFT JOIN ledger_entry rl ON rl.source_key = 'purchase:' || p.purchase_id::text || ':release'
  LEFT JOIN ledger_entry rf ON rf.source_key = 'purchase:' || p.purchase_id::text || ':refund'
  WHERE p.mode = 'live' AND p.paid_at IS NOT NULL`;

/** Только то, что читает репозиторий: клиент Prisma и его транзакция подходят одинаково. */
type SqlClient = Pick<PrismaClient, "$queryRaw">;

@Injectable()
export class PrismaPaymentPostingsRepository implements PaymentPostingsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: SqlClient) {}

  async candidates(stream: PostingStream, now: Date, after: StreamCursor | null, limit: number): Promise<PostingCandidate[]> {
    const rows = await this.prisma.$queryRaw(this.query(stream, now, after, limit));
    return rowsSchema.parse(rows).map((row) => ({
      purchase: {
        purchaseId: row.purchaseId,
        product: row.product,
        chargedStars: row.stars,
        mode: "live",
        paidAt: row.paidAt,
        refundedAt: row.refundedAt,
        platform: row.platform,
      },
      posted: {
        paid: row.paidPosted ? { releaseAt: row.releaseAt } : null,
        release: row.releasePosted,
        refund: row.refundPosted,
      },
    }));
  }

  private query(stream: PostingStream, now: Date, after: StreamCursor | null, limit: number): Prisma.Sql {
    // Курсор сравнивается тем же кортежем, по которому идёт сортировка: порядок строк и «после курсора» не расходятся.
    const key = stream === "unpaid" ? Prisma.sql`q."paidAt"` : stream === "unrefunded" ? Prisma.sql`q."refundedAt"` : Prisma.sql`q."releaseAt"`;
    const cursor = after === null ? Prisma.empty : Prisma.sql`AND (${key}, q."purchaseId") > (${after.at}::timestamptz, ${after.purchaseId})`;
    const condition =
      stream === "unpaid"
        ? Prisma.sql`NOT q."paidPosted"`
        : stream === "unrefunded"
          ? Prisma.sql`q."refundedAt" IS NOT NULL AND q."refundedAt" <= ${now}::timestamptz AND NOT q."refundPosted"`
          : // Возврат раньше срока выход из холда отменяет: такая покупка в выборку не идёт, иначе она висела бы в ней вечно.
            Prisma.sql`q."paidPosted" AND NOT q."releasePosted" AND q."releaseAt" <= ${now}::timestamptz
              AND (q."refundedAt" IS NULL OR q."refundedAt" >= q."releaseAt")`;
    return Prisma.sql`SELECT * FROM (${BASE}) q WHERE ${condition} ${cursor} ORDER BY ${key}, q."purchaseId" LIMIT ${limit}`;
  }
}
