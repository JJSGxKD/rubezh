import { isCurrencyCode } from "@bh/fx";
import { z } from "zod";

/**
 * Ручные операции учёта: что вводит человек (docs/37-accounting.md §4, §6, §12, Р220, Р221, tasks/T-0461).
 * Суммы — десятичными строками в валюте места: «1500.00», «52.3». В проводку их превращает сборщик
 * (`builders.ts`), а не клиент: человек описывает событие, а не строки журнала. Схема строгая — лишнее поле
 * это опечатка клиента, а не повод молча его проигнорировать.
 */

export const OPERATION_KINDS = ["transfer", "exchange", "expense", "income", "loan", "reversal"] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

export const OPERATION_STATUSES = ["draft", "pending", "posted", "rejected"] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

/** Причина или описание: короче трёх знаков — отписка, длиннее пятисот не влезает в описание проводки. */
export const NOTE_MIN = 3;
export const NOTE_MAX = 500;
export const LINK_MAX = 500;
/** Имя кредитора входит в название счёта «Заём: <имя>» (128 знаков в базе). */
export const LENDER_MAX = 100;
export const RECEIPT_NUMBER_MAX = 64;

/** Раньше учёта в проекте событий не бывает: дата до этого дня — опечатка в годе. */
export const EARLIEST_EVENT = new Date("2026-01-01T00:00:00.000Z");

/** Сумма — строка без знака и без экспоненты: «1e3» и «-5» не проходят, нулевую и лишние знаки проверит сборщик. */
const money = z.string().regex(/^\d{1,18}(\.\d{1,18})?$/u);
const currencyCode = z.string().refine(isCurrencyCode);
/** Идентификатор счёта места или статьи: `bank.rub`, `stars.bot.available`, `ads_taddy`. */
const idSchema = z.string().regex(/^[a-z0-9._-]{1,64}$/u);
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);

/** «2026-11-13» или полное время с поясом: «2026-11-13T09:30:00Z». Существует ли такая дата, проверит сборщик. */
const eventAt = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/u);

function isHttpsLink(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    // Строка, которую не разобрать как адрес, — просто не ссылка: отказ схемы, а не ошибка сервера.
    return false;
  }
}

const link = z.string().max(LINK_MAX).refine(isHttpsLink);

/** Снимок чека — id картинки в хранилище картинок панели (SHA-256 в hex); есть ли она и того ли профиля, проверяет сервис. */
const receiptImage = z.string().regex(/^[0-9a-f]{64}$/u);

/** Поля, общие для всех видов: причина или описание, ссылка на подтверждение, снимок чека, дата события. */
const common = {
  note: z.string().trim().min(NOTE_MIN).max(NOTE_MAX),
  link: link.optional(),
  receiptImage: receiptImage.optional(),
  at: eventAt,
};

/**
 * Комиссия, как её вводит человек: процент — в валюте списания, фикса — в своей. Не задана вовсе — берётся
 * шаблон места списания (`applyFeeTemplate`); задана пустой `{}` — комиссии нет, хотя шаблон есть.
 */
const feeBody = z.strictObject({
  /** процентная часть, в валюте места списания */
  amount: money.optional(),
  fixed: z
    .strictObject({
      amount: money,
      currency: currencyCode,
      /** место, с которого списана фикса в чужой валюте; не задано — единственное место в этой валюте */
      from: idSchema.optional(),
    })
    .optional(),
});

/** Чек НПД (Р221): без номера и ссылки допустим — картинку чека прикладывает T-0462, плательщик нужен всегда. */
const receipt = z.strictObject({
  number: z.string().trim().min(1).max(RECEIPT_NUMBER_MAX).optional(),
  link: link.optional(),
  payer: z.enum(["individual", "legal"]),
});

export const operationInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("transfer"), ...common, from: idSchema, to: idSchema, amount: money, fee: feeBody.optional() }),
  z.strictObject({ kind: z.literal("exchange"), ...common, from: idSchema, to: idSchema, given: money, received: money, fee: feeBody.optional(), receipt: receipt.optional() }),
  z.strictObject({ kind: z.literal("expense"), ...common, from: idSchema, article: idSchema, amount: money }),
  z.strictObject({ kind: z.literal("income"), ...common, to: idSchema, article: idSchema, amount: money, forMonth: monthSchema, receipt: receipt.optional() }),
  z.strictObject({
    kind: z.literal("loan"),
    ...common,
    to: idSchema,
    lender: z.string().trim().min(1).max(LENDER_MAX),
    amount: money,
    /** премия сверх тела, в валюте займа; без премии — «0» */
    premium: money,
    /** ставка погашения: доля чистой прибыли месяца в сотых долях процента */
    repaymentBp: z.number().int().min(0).max(10_000),
  }),
  z.strictObject({ kind: z.literal("reversal"), ...common, sourceKey: z.string().trim().min(1).max(128) }),
]);

export type OperationInput = z.infer<typeof operationInputSchema>;
export type OperationInputOf<K extends OperationKind> = Extract<OperationInput, { kind: K }>;
export type FeeBody = z.infer<typeof feeBody>;
export type ReceiptInput = z.infer<typeof receipt>;

/** Виды, которые собираются в проводку сборщиком; исправление берёт строки исходной проводки у журнала. */
export type BuildableInput = Exclude<OperationInput, { kind: "reversal" }>;

/**
 * Что лежит в `ledger_operation.input`: всё, кроме причины, ссылки и снимка чека, — у них свои колонки. Вместе с
 * ними из этого снова собирается ввод человека, поэтому читается строка той же схемой, что и тело запроса.
 */
export type StoredFields = Record<string, unknown>;

export function splitInput(input: OperationInput): { fields: StoredFields; note: string; link: string | null; receiptImage: string | null } {
  const { note, link: attached, receiptImage: image, ...fields } = input;
  return { fields, note, link: attached ?? null, receiptImage: image ?? null };
}
