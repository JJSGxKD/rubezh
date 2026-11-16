import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { lastEndOf, nextGiftWindow, type GiftWindow } from "./vip-gift-rules.js";

/**
 * VIP в подарок в базе (`vip_gift`, `vip_gift_order`; tasks/T-0249). Цепочка подарков получателя
 * меняется по одному под тем же замком, что и цепочка периодов подписки (`vip:<аккаунт>`): выдача
 * нового подарка, возврат и выдача периода не читают друг друга на середине записи.
 */

export const VIP_GIFT_REPOSITORY = Symbol("VIP_GIFT_REPOSITORY");

export interface GiftOrderRecord {
  purchaseId: string;
  recipientAccountId: string;
  at: Date;
}

export interface GiftIssue {
  purchaseId: string;
  giverAccountId: string;
  recipientAccountId: string;
  days: number;
  /** момент выдачи: с него и считается «сейчас» */
  at: Date;
}

export interface IssuedGift {
  startsAt: Date;
  endsAt: Date;
  /** `null` — подарок в силе */
  revokedAt: Date | null;
  /** `false` — за эту оплату срок уже был: повтор выдачи */
  created: boolean;
}

/** Что сделал возврат с подарком. */
export type GiftRevocation =
  | { kind: "none" }
  | { kind: "revoked" | "repeat"; recipientAccountId: string; startsAt: Date; endsAt: Date; revokedAt: Date };

export interface VipGiftRepository {
  /** Записать, кому дарит покупка; повтор того же заказа ничего не меняет. */
  recordOrder(order: GiftOrderRecord): Promise<void>;
  /** Получатель из заказа; `null` — заказа нет. */
  recipientOf(purchaseId: string): Promise<string | null>;
  /**
   * Выдать срок: с «сейчас» либо с конца последнего неотозванного подарка и подписки получателя —
   * что позже. Под замком получателя; повтор по той же оплате отдаёт тот же срок. Покупка,
   * возвращённая раньше выдачи, ложится уже отозванной, и VIP не включает.
   */
  issue(input: GiftIssue): Promise<IssuedGift>;
  /**
   * Отозвать срок подарка к моменту `at`. Повтор срок не меняет. Подарки, стоящие за ним, не двигаются.
   * `none` — срока нет: выдача ещё не прошла, а когда пройдёт, увидит возврат сама.
   */
  revoke(purchaseId: string, at: Date): Promise<GiftRevocation>;
  /**
   * Подаренные сроки получателя, поздний конец первым, не больше `GIFTS_READ`. С `since` — только те, что
   * кончаются позже этого момента: так спрашивают «идёт ли VIP сейчас», и запрос идёт по индексу `(recipient, ends_at)`.
   */
  windows(accountId: string, since: Date | null): Promise<GiftWindow[]>;
}

/** Сколько подаренных сроков получателя читать: больше бывает, только если подарки идут годами. */
export const GIFTS_READ = 20;

const windowSchema = z.object({ starts_at: z.date(), ends_at: z.date(), revoked_at: z.date().nullable() });
const purchaseSchema = z.object({ status: z.string(), refunded_at: z.date().nullable() });
const endSchema = z.object({ until: z.date().nullable() });

@Injectable()
export class PrismaVipGiftRepository implements VipGiftRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async recordOrder(order: GiftOrderRecord): Promise<void> {
    await this.prisma.vipGiftOrder.createMany({
      data: [{ purchaseId: order.purchaseId, recipientAccountId: order.recipientAccountId, createdAt: order.at }],
      skipDuplicates: true,
    });
  }

  async recipientOf(purchaseId: string): Promise<string | null> {
    const found = await this.prisma.vipGiftOrder.findUnique({ where: { purchaseId }, select: { recipientAccountId: true } });
    return found?.recipientAccountId ?? null;
  }

  async issue(input: GiftIssue): Promise<IssuedGift> {
    return await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`vip:${input.recipientAccountId}`}))`;
      const [known] = await tx.$queryRaw<unknown[]>`SELECT starts_at, ends_at, revoked_at FROM vip_gift WHERE purchase_id = ${input.purchaseId}::uuid`;
      if (known !== undefined) return { ...giftOf(known), created: false };

      // Покупка могла быть возвращена, пока выдача ждала в очереди: возврат пришёл раньше срока и ничего не нашёл.
      const [bought] = await tx.$queryRaw<unknown[]>`SELECT status::text AS status, refunded_at FROM purchase WHERE purchase_id = ${input.purchaseId}::uuid`;
      const purchase = purchaseSchema.parse(bought);

      const [subscription] = await tx.$queryRaw<unknown[]>`SELECT max(ends_at) AS until FROM vip_period WHERE account_id = ${input.recipientAccountId}::uuid`;
      const open = await tx.$queryRaw<unknown[]>`
        SELECT starts_at, ends_at, revoked_at FROM vip_gift
        WHERE recipient_account_id = ${input.recipientAccountId}::uuid AND revoked_at IS NULL AND ends_at > ${input.at}::timestamptz`;
      const lastEnd = lastEndOf(endSchema.parse(subscription).until, open.map(giftOf));
      const window = nextGiftWindow(lastEnd, input.at, input.days);

      // Возвращённый до выдачи срок не начинается: отозван в момент начала или раньше.
      const revokedAt = purchase.status === "refunded" ? earlier(purchase.refunded_at ?? input.at, window.startsAt) : null;
      await tx.$executeRaw`
        INSERT INTO vip_gift (purchase_id, giver_account_id, recipient_account_id, starts_at, ends_at, revoked_at, created_at)
        VALUES (${input.purchaseId}::uuid, ${input.giverAccountId}::uuid, ${input.recipientAccountId}::uuid, ${window.startsAt}, ${window.endsAt}, ${revokedAt}, ${input.at})
        ON CONFLICT (purchase_id) DO NOTHING`;
      return { startsAt: window.startsAt, endsAt: window.endsAt, revokedAt, created: true };
    });
  }

  async revoke(purchaseId: string, at: Date): Promise<GiftRevocation> {
    const recipientAccountId = await this.recipientOf(purchaseId);
    if (recipientAccountId === null) return { kind: "none" };
    return await this.prisma.$transaction(async (tx) => {
      // Замок получателя берётся до чтения срока: выдача, которая идёт параллельно, либо уже записала срок, либо
      // запишет его после отзыва — и увидит возвращённую покупку.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`vip:${recipientAccountId}`}))`;
      const [found] = await tx.$queryRaw<unknown[]>`SELECT starts_at, ends_at, revoked_at FROM vip_gift WHERE purchase_id = ${purchaseId}::uuid`;
      if (found === undefined) return { kind: "none" };
      const gift = giftOf(found);
      if (gift.revokedAt !== null) return { kind: "repeat", recipientAccountId, startsAt: gift.startsAt, endsAt: gift.endsAt, revokedAt: gift.revokedAt };
      await tx.$executeRaw`UPDATE vip_gift SET revoked_at = ${at} WHERE purchase_id = ${purchaseId}::uuid AND revoked_at IS NULL`;
      return { kind: "revoked", recipientAccountId, startsAt: gift.startsAt, endsAt: gift.endsAt, revokedAt: at };
    });
  }

  async windows(accountId: string, since: Date | null): Promise<GiftWindow[]> {
    const rows = await this.prisma.vipGift.findMany({
      where: { recipientAccountId: accountId, ...(since === null ? {} : { endsAt: { gt: since } }) },
      orderBy: { endsAt: "desc" },
      take: GIFTS_READ,
      select: { startsAt: true, endsAt: true, revokedAt: true },
    });
    return rows;
  }
}

function giftOf(raw: unknown): GiftWindow {
  const row = windowSchema.parse(raw);
  return { startsAt: row.starts_at, endsAt: row.ends_at, revokedAt: row.revoked_at };
}

function earlier(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}
