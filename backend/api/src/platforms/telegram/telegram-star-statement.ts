import { Logger } from "@nestjs/common";
import { z } from "zod";
import type { PaymentStatement, StatementEntry } from "../ports/payment-statement.js";
import type { TelegramBotApi } from "./telegram-bot-api.js";

/**
 * Выписка звёзд бота на методе Bot API `getStarTransactions`
 * (docs/35-stage4-plan.md, Р209, WP53). Операции приходят по порядку
 * времени, от старых к новым; у входящей оплаты `id` совпадает с
 * `telegram_payment_charge_id`, у возврата — с `id` исходной оплаты.
 * Счётчика «всего» нет: страница короче `limit` — дальше пусто.
 */

export type StatementBotApi = Pick<TelegramBotApi, "getStarTransactions">;

/** Больше Bot API на странице не отдаёт. */
const PAGE_MAX = 100;

const logger = new Logger("telegram");

/** Сторона операции: пользователь, Fragment, реклама и прочее; незнакомые поля пропускаем. */
const partySchema = z
  .object({
    type: z.string(),
    transaction_type: z.string().optional(),
    user: z.object({ id: z.number().int() }).passthrough().optional(),
    invoice_payload: z.string().optional(),
    subscription_period: z.number().int().optional(),
  })
  .passthrough();

const transactionSchema = z
  .object({
    id: z.string().min(1).max(256),
    amount: z.number().int(),
    date: z.number().int(),
    source: partySchema.optional(),
    receiver: partySchema.optional(),
  })
  .passthrough();

const responseSchema = z.object({ transactions: z.array(z.unknown()) }).passthrough();

/** Строка, не прошедшая схему: из неё берём только то, что читается, — идентификатор. */
const looseRowSchema = z.object({ id: z.string().min(1).max(256), amount: z.number().int().optional(), date: z.number().int().optional() }).passthrough();

type Party = z.infer<typeof partySchema>;

function isInvoicePaymentOfUser(party: Party | undefined): party is Party & { user: { id: number } } {
  return party?.type === "user" && party.transaction_type === "invoice_payment" && party.user !== undefined;
}

function convert(row: z.infer<typeof transactionSchema>): StatementEntry {
  const base = { id: row.id, amount: row.amount, at: new Date(row.date * 1000) };
  if (isInvoicePaymentOfUser(row.source)) {
    return {
      ...base,
      kind: "payment",
      payerId: String(row.source.user.id),
      payload: row.source.invoice_payload ?? null,
      subscriptionPeriodSec: row.source.subscription_period ?? null,
    };
  }
  if (isInvoicePaymentOfUser(row.receiver)) {
    return { ...base, kind: "refund", payerId: String(row.receiver.user.id), payload: row.receiver.invoice_payload ?? null, subscriptionPeriodSec: null };
  }
  return { ...base, kind: "other", payerId: null, payload: null, subscriptionPeriodSec: null };
}

export class TelegramStarStatement implements PaymentStatement {
  readonly platform = "telegram" as const;
  readonly pageMax = PAGE_MAX;

  constructor(private readonly api: StatementBotApi) {}

  async page(offset: number, limit: number): Promise<StatementEntry[]> {
    const safeOffset = Math.max(0, Math.trunc(offset));
    const safeLimit = Math.min(PAGE_MAX, Math.max(1, Math.trunc(limit)));
    const parsed = responseSchema.safeParse(await this.api.getStarTransactions(safeOffset, safeLimit));
    if (!parsed.success) throw new Error("выписка Telegram без transactions");

    const entries: StatementEntry[] = [];
    parsed.data.transactions.forEach((raw, position) => {
      const row = transactionSchema.safeParse(raw);
      if (row.success) {
        entries.push(convert(row.data));
        return;
      }
      // Одна битая строка не должна останавливать страницу: иначе сверка
      // застряла бы навсегда на одной позиции.
      logger.warn(JSON.stringify({ module: "telegram", event: "star_statement_row_skipped", position }));
      const loose = looseRowSchema.safeParse(raw);
      if (!loose.success) return;
      entries.push({
        id: loose.data.id,
        kind: "other",
        amount: loose.data.amount ?? 0,
        at: new Date((loose.data.date ?? 0) * 1000),
        payerId: null,
        payload: null,
        subscriptionPeriodSec: null,
      });
    });
    return entries;
  }
}
