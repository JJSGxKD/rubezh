import { Inject, Injectable } from "@nestjs/common";
import type { PeriodHooks } from "../periods/period-hooks.js";
import { db } from "./payout-facts.js";
import { PayoutLock, type PayoutLockPort } from "./payout-lock.js";
import { PayoutNotices } from "./payout-notices.js";
import { PAYOUTS_REPOSITORY, type PayoutsRepository } from "./payouts.repository.js";

/**
 * Хуки месяца учёта для выплат (docs/37-accounting.md §13, Р222, tasks/T-0469): месяцы (`periods.service.ts`) знают о
 * выплатах только через них. После первой выплаты закрытие не снять; снятие сбрасывает подтверждения и отзывает отчёт;
 * закрытие сообщает участникам, что отчёт готов; снятие закрытия и выплата идут под одним замком месяца.
 */
@Injectable()
export class PayoutPeriodHooks implements PeriodHooks {
  constructor(
    @Inject(PAYOUTS_REPOSITORY) private readonly repository: PayoutsRepository,
    @Inject(PayoutNotices) private readonly notices: Pick<PayoutNotices, "reportReady" | "recalled">,
    @Inject(PayoutLock) private readonly lock: PayoutLockPort,
  ) {}

  async hasPayouts(period: string): Promise<boolean> {
    return await db(this.repository.hasPayouts(period));
  }

  /**
   * Стереть подтверждения месяца и отозвать отчёт. Сообщение уходит, даже если стереть не вышло: закрытие уже снято, и
   * участнику надо знать, что прежний отчёт недействителен; а подтверждение, оставшееся в базе, выплаты всё равно не
   * пропустят — оно старше последнего закрытия (`currentConfirmation`). Сбой стирания идёт наверх.
   */
  async resetConfirmations(period: string, recall?: { round: number; reason: string }): Promise<void> {
    try {
      await db(this.repository.clearConfirmations(period));
    } finally {
      if (recall !== undefined) await this.notices.recalled(period, recall.round, recall.reason);
    }
  }

  async closed(period: string, round: number): Promise<void> {
    await this.notices.reportReady(period, round);
  }

  async exclusive<T>(period: string, work: () => Promise<T>): Promise<T> {
    return await this.lock.run(period, work);
  }
}
