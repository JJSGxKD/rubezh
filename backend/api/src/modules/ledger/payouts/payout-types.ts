/**
 * Типы выплат и подтверждений (docs/37-accounting.md §13, Р222, tasks/T-0469): то, что лежит в базе и ходит между
 * репозиторием, правилами и сервисами. Отдельным файлом — чтобы чистые правила не тянули за собой Prisma.
 */

export type ConfirmationStatus = "confirmed" | "disputed";

/** Решение участника по отчёту месяца. */
export interface StoredConfirmation {
  period: string;
  accountId: string;
  status: ConfirmationStatus;
  /** у спора обязателен, у подтверждения — по желанию */
  comment: string | null;
  decidedAt: Date;
}

/** Строка месяца для выплат: состояние, время закрытия, номер раза и снимок (JSON из базы — форму разбирает читающий). */
export interface StoredPeriod {
  period: string;
  status: "open" | "review" | "closed";
  closedAt: Date | null;
  reopenedCount: number;
  snapshot: unknown;
}

/**
 * Проведённая и не сторнированная выплата месяца: чьё обязательство она погасила или в какой счёт «Выплаты владельцу»
 * легла. Сумма — по строке этого счёта (в валюте счёта), а не по вводу: так сходится с журналом.
 */
export interface PayoutRecord {
  operationId: string;
  period: string;
  payee: string;
  accountId: string;
  currency: string;
  minor: bigint;
  overrideReason: string | null;
  at: Date;
}

/** Заём, которому платят транш: счёт-обязательство и валюта. */
export interface StoredLoanAccount {
  loanId: string;
  accountId: string;
  currency: string;
  lender: string;
}
