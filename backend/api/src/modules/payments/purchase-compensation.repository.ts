import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { Prisma } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * Компенсации за сбой оплаты в Postgres (docs/35-stage4-plan.md, Р209, WP53,
 * tasks/T-0435). Запрос к базе живёт здесь, а не в сервисе
 * (docs/15-engineering-standards.md §2.3).
 *
 * **Одна компенсация на покупку — первичным ключом `purchase_id`**, а не
 * проверкой в коде: два одновременных запроса упираются в индекс, и строка
 * остаётся одна. Строка вставляется до кошелька, `credited_at` — после него:
 * упало между — повтор доначислит ту же сумму из строки.
 */

/** Строка таблицы: что решено начислить, кем, и легло ли это в кошелёк. */
export interface CompensationRow {
  purchaseId: string;
  accountId: string;
  /** пока только `gems` (Р2) */
  resource: string;
  amount: number;
  /** что предложила панель: по разнице видно, правили ли сумму */
  suggested: number | null;
  note: string;
  actorAccountId: string;
  createdAt: Date;
  /** когда легло в кошелёк; `null` — начисление не прошло, повтор доделает */
  creditedAt: Date | null;
}

export const PURCHASE_COMPENSATION_REPOSITORY = Symbol("PURCHASE_COMPENSATION_REPOSITORY");

export interface PurchaseCompensationRepository {
  /** `exists` — у покупки уже есть компенсация: ничего не изменилось. */
  insert(row: CompensationRow): Promise<"inserted" | "exists">;
  byPurchase(purchaseId: string): Promise<CompensationRow | null>;
  /** Строки тех из покупок, у кого они есть, — одним запросом на страницу ленты. */
  byPurchases(purchaseIds: readonly string[]): Promise<Map<string, CompensationRow>>;
  /** `true` — отметка поставлена этим вызовом; `false` — её уже ставил другой (или строки нет). */
  markCredited(purchaseId: string, at: Date): Promise<boolean>;
}

/** Нарушение уникальности — код Prisma; внешний ключ и прочее (`P2003`) — настоящая ошибка и идёт наверх. */
const UNIQUE_VIOLATION = "P2002";

const COLUMNS = { purchaseId: true, accountId: true, resource: true, amount: true, suggested: true, note: true, actorAccountId: true, createdAt: true, creditedAt: true } as const;

@Injectable()
export class PrismaPurchaseCompensationRepository implements PurchaseCompensationRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async insert(row: CompensationRow): Promise<"inserted" | "exists"> {
    try {
      await this.prisma.purchaseCompensation.create({ data: row });
      return "inserted";
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION) return "exists";
      throw error;
    }
  }

  async byPurchase(purchaseId: string): Promise<CompensationRow | null> {
    return await this.prisma.purchaseCompensation.findUnique({ where: { purchaseId }, select: COLUMNS });
  }

  async byPurchases(purchaseIds: readonly string[]): Promise<Map<string, CompensationRow>> {
    if (purchaseIds.length === 0) return new Map();
    const rows = await this.prisma.purchaseCompensation.findMany({ where: { purchaseId: { in: [...purchaseIds] } }, select: COLUMNS });
    return new Map(rows.map((row) => [row.purchaseId, row]));
  }

  async markCredited(purchaseId: string, at: Date): Promise<boolean> {
    // Условие в самом `UPDATE`: отметку ставит только один из двух одновременных вызовов.
    const updated = await this.prisma.purchaseCompensation.updateMany({ where: { purchaseId, creditedAt: null }, data: { creditedAt: at } });
    return updated.count === 1;
  }
}
