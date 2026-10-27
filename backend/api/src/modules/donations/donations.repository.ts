import { Inject, Injectable } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * Знак «Поддержал проект» в базе (docs/35-stage4-plan.md, Р109): поле
 * `account.supporter_at`. Сами донаты — строки `purchase` с `product = 'donation'`
 * — ведёт модуль оплаты; здесь только знак и вопрос «есть ли ещё донат, который
 * его держит».
 */

export interface DonationsRepository {
  isSupporter(accountId: string): Promise<boolean>;
  /**
   * Поставить знак. Дата первого доната не перезаписывается, повтор безвреден
   * (выдачу зовёт задание подтверждения, и упавшее задание повторяется целиком).
   */
  markSupporter(accountId: string, at: Date): Promise<void>;
  /**
   * Снять знак, если у аккаунта нет другого действующего доната — оплаченного,
   * не возвращённого и без заказанного возврата. `true` — знака после вызова нет
   * (снят этим вызовом или уже был снят: обработка возврата повторяется, и
   * повтор обязан дать тот же ответ); `false` — знак остался.
   */
  clearSupporterUnlessOther(accountId: string, exceptPurchaseId: string): Promise<boolean>;
}

export const DONATIONS_REPOSITORY = Symbol("DONATIONS_REPOSITORY");

/** Каждый вызов базы с потолком (CLAUDE.md, «каждый await внешнего вызова — с таймаутом»). */
const DB_TIMEOUT_MS = 3_000;
const TX_OPTIONS = { maxWait: 2_000, timeout: DB_TIMEOUT_MS } as const;

@Injectable()
export class PrismaDonationsRepository implements DonationsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async isSupporter(accountId: string): Promise<boolean> {
    const row = await withTimeout(this.prisma.account.findUnique({ where: { accountId }, select: { supporterAt: true } }), DB_TIMEOUT_MS, "знак доната: чтение");
    return row !== null && row.supporterAt !== null;
  }

  async markSupporter(accountId: string, at: Date): Promise<void> {
    // COALESCE, а не условие `supporter_at IS NULL` в WHERE: двадцать выдач разом оставят одну дату —
    // ту, что записана первой, — а строка аккаунта блокируется всегда. Со снятием знака
    // (`clearSupporterUnlessOther`) это важно: пометка, пришедшая во время снятия, дождётся его
    // и поставит знак заново, а не пройдёт мимо по ещё не снятому значению.
    await withTimeout(
      this.prisma.$executeRaw`UPDATE account SET supporter_at = COALESCE(supporter_at, ${at}::timestamptz) WHERE account_id = ${accountId}::uuid`,
      DB_TIMEOUT_MS,
      "знак доната: пометка",
    );
  }

  async clearSupporterUnlessOther(accountId: string, exceptPurchaseId: string): Promise<boolean> {
    return await withTimeout(
      this.prisma.$transaction(async (tx) => {
        // Строка аккаунта блокируется на время проверки: оплата другого доната, ставящая знак
        // в эту же секунду, дождётся и увидит результат, а не потеряет свой знак под нашим снятием.
        await tx.$queryRaw`SELECT account_id FROM account WHERE account_id = ${accountId}::uuid FOR UPDATE`;
        const others = await tx.purchase.count({
          where: { accountId, product: "donation", status: "paid", refundRequestedAt: null, purchaseId: { not: exceptPurchaseId } },
        });
        if (others > 0) return false;
        await tx.account.updateMany({ where: { accountId, supporterAt: { not: null } }, data: { supporterAt: null } });
        return true;
      }, TX_OPTIONS),
      DB_TIMEOUT_MS + 1_000,
      "знак доната: снятие",
    );
  }
}
