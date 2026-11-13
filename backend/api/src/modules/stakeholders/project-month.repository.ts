import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { PurchaseRow } from "./project-month.js";
import { monthKey } from "./stakeholder-rules.js";

/**
 * Живые оплаты для месяца проекта (docs/35-stage4-plan.md Р218, tasks/T-0453). Выборка одна: покупки с оплатой в
 * границах месяца по UTC и площадка аккаунта покупателя; тестовые оплаты (`mode = 'test'`) не входят, возвращённые
 * приходят с отметкой — вычитает расчёт. Индекс `purchase(mode, paid_at)` держит выборку по границам.
 */

export const PROJECT_MONTH_REPOSITORY = Symbol("PROJECT_MONTH_REPOSITORY");

export interface ProjectMonthRepository {
  /** Живые оплаты с `paid_at` в `[from, to)`. */
  purchases(from: Date, to: Date): Promise<PurchaseRow[]>;
  /** Месяц `ГГГГ-ММ` самой ранней живой оплаты; `null` — оплат не было. */
  firstPaidMonth(): Promise<string | null>;
}

const purchaseSchema = z.array(
  z.object({
    stars: z.coerce.number().int().nonnegative(),
    paidAt: z.coerce.date(),
    refundedAt: z.coerce.date().nullable(),
    product: z.enum(["continue_run", "shop_item", "vip", "donation"]),
    platform: z.enum(["telegram", "max", "vk", "web"]),
  }),
);

const firstSchema = z.array(z.object({ at: z.coerce.date().nullable() }));

/** Только то, что читает репозиторий: клиент Prisma и его транзакция подходят одинаково. */
type SqlClient = Pick<PrismaClient, "$queryRaw">;

@Injectable()
export class PrismaProjectMonthRepository implements ProjectMonthRepository {
  constructor(@Inject(PRISMA) private readonly prisma: SqlClient) {}

  async purchases(from: Date, to: Date): Promise<PurchaseRow[]> {
    const rows = await this.prisma.$queryRaw`
      SELECT p.charged_stars AS stars,
             p.paid_at AS "paidAt",
             p.refunded_at AS "refundedAt",
             p.product::text AS product,
             a.platform::text AS platform
      FROM purchase p JOIN account a ON a.account_id = p.account_id
      WHERE p.mode = 'live' AND p.paid_at >= ${from} AND p.paid_at < ${to}`;
    return purchaseSchema.parse(rows).map((row) => ({
      chargedStars: row.stars,
      paidAt: row.paidAt,
      refundedAt: row.refundedAt,
      product: row.product,
      platform: row.platform,
    }));
  }

  async firstPaidMonth(): Promise<string | null> {
    const rows = await this.prisma.$queryRaw`SELECT min(paid_at) AS at FROM purchase WHERE mode = 'live' AND paid_at IS NOT NULL`;
    const at = firstSchema.parse(rows)[0]?.at ?? null;
    return at === null ? null : monthKey(at);
  }
}
