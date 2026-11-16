import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { lockSourceSlot } from "./source-slot.js";

/**
 * Метка партнёрки Telegram в Postgres (docs/35-stage4-plan.md Р97, T-0072). Запрос к базе живёт
 * здесь, а не в слушателе входа (docs/15-engineering-standards.md §2.3).
 */

export interface TelegramAffiliateMark {
  /** параметр целиком, как пришёл: `_tgr_<id>` */
  startParam: string;
  /** идентификатор внутри параметра */
  ref: string;
  markedAt: Date;
}

export type MarkOutcome =
  | { status: "marked" }
  /** метка уже стоит: она одна на аккаунт и навсегда, повтор её не меняет */
  | { status: "already" }
  /** слот источника занят приглашением друга или партнёром: метка не ставится */
  | { status: "slot_taken"; slot: "referral" | "partner" };

export const TELEGRAM_AFFILIATE_REPOSITORY = Symbol("TELEGRAM_AFFILIATE_REPOSITORY");

export interface TelegramAffiliateRepository {
  /** Поставить метку, если слот свободен. Одна на аккаунт, навсегда: повтор с другим id её не меняет. */
  mark(input: { accountId: string; startParam: string; ref: string; at: Date }): Promise<MarkOutcome>;
  byAccount(accountId: string): Promise<TelegramAffiliateMark | null>;
}

const TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;

@Injectable()
export class PrismaTelegramAffiliateRepository implements TelegramAffiliateRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async byAccount(accountId: string): Promise<TelegramAffiliateMark | null> {
    return await this.prisma.telegramAffiliateMark.findUnique({ where: { accountId }, select: { startParam: true, ref: true, markedAt: true } });
  }

  async mark(input: { accountId: string; startParam: string; ref: string; at: Date }): Promise<MarkOutcome> {
    // Помеченный игрок возвращается по той же ссылке часто: чтение по первичному ключу дешевле
    // транзакции с блокировкой аккаунта.
    if ((await this.byAccount(input.accountId)) !== null) return { status: "already" };
    // Слот один на метку, реферала и партнёра, и решается под их общей блокировкой аккаунта:
    // метка и привязка друга в гонке дают одного победителя (docs/23-referral-and-partner-program.md §5).
    return await this.prisma.$transaction(async (tx): Promise<MarkOutcome> => {
      const slot = await lockSourceSlot(tx, input.accountId);
      if (slot === "telegram") return { status: "already" };
      if (slot !== "free") return { status: "slot_taken", slot };
      // Слот под блокировкой свободен, так что дубля быть не должно; первичный ключ — последний рубеж.
      const inserted = await tx.$executeRaw`
        INSERT INTO telegram_affiliate_mark (account_id, start_param, ref, marked_at)
        VALUES (${input.accountId}::uuid, ${input.startParam}, ${input.ref}, ${input.at})
        ON CONFLICT (account_id) DO NOTHING`;
      return inserted > 0 ? { status: "marked" } : { status: "already" };
    }, TX_OPTIONS);
  }
}
