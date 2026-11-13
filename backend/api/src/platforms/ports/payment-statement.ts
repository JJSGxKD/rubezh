import type { PlatformId } from "./platform.js";

/**
 * Выписка площадки (docs/35-stage4-plan.md, Р209, WP53): что площадка на
 * самом деле списала и вернула. Сверка оплат читает её через этот порт и не
 * знает, откуда она берётся; у Telegram это операции звёзд бота. Отдельный
 * порт, а не метод `PaymentProvider`: выписка — чтение истории счёта бота, а
 * не оплата игрока, и у площадки может быть оплата без выписки — тогда
 * сверки нет, порт просто не регистрируется.
 */

export type StatementEntryKind = "payment" | "refund" | "other";

export interface StatementEntry {
  /** идентификатор операции: у оплаты и её возврата — идентификатор оплаты */
  id: string;
  kind: StatementEntryKind;
  /** сколько — в единицах валюты площадки, у звёзд — звёзды */
  amount: number;
  at: Date;
  /** игрок на площадке: кто платил или кому вернули; у прочих — null */
  payerId: string | null;
  /** что стояло в счёте — у нас id покупки; у прочих — null */
  payload: string | null;
  subscriptionPeriodSec: number | null;
}

export interface PaymentStatement {
  readonly platform: PlatformId;
  /** больше страница не бывает */
  readonly pageMax: number;
  /**
   * Страница по времени, от старых к новым, с позиции `offset`; короче
   * `limit` — дальше пусто. Ошибка площадки — исключение: сверка повторит
   * в следующий раз.
   */
  page(offset: number, limit: number): Promise<StatementEntry[]>;
}

/** Выписки всех площадок, у которых она есть. */
export class PaymentStatements {
  constructor(private readonly all: readonly PaymentStatement[]) {}

  for(platform: PlatformId): PaymentStatement | null {
    return this.all.find((statement) => statement.platform === platform) ?? null;
  }

  list(): readonly PaymentStatement[] {
    return this.all;
  }
}
