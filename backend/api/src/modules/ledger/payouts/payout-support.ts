import { Inject, Injectable } from "@nestjs/common";
import { SETTINGS_READER, type SettingsReader } from "../../settings/settings.service.js";
import type { OperationInputOf } from "../operations/operation-input.js";
import { loadPayoutFacts } from "./payout-facts.js";
import { PayoutLock, type PayoutLockPort } from "./payout-lock.js";
import { PayoutNotices } from "./payout-notices.js";
import type { PayoutFacts } from "./payout-rules.js";
import { PAYOUTS_REPOSITORY, type PayoutsRepository } from "./payouts.repository.js";

/**
 * Что операциям учёта нужно от выплат (docs/37-accounting.md §13, Р222, tasks/T-0469): данные месяца для сборщика,
 * замок месяца на время проведения и сообщение «выплачено». `OperationsService` знает только этот порт: выплата — один из
 * видов операций, а правила месяца живут здесь.
 */
export interface PayoutSupport {
  facts(input: OperationInputOf<"payout">, now: Date, operationId?: string): Promise<PayoutFacts>;
  /** Проведение выплаты под замком месяца: проверка остатка и запись проводки идут вместе, без чужих выплат и снятия закрытия. */
  exclusive<T>(period: string, work: () => Promise<T>): Promise<T>;
  /** Выплата проведена: участнику — сообщение. Не бросает. */
  announcePaid(operationId: string, input: OperationInputOf<"payout">): Promise<void>;
}

export const PAYOUT_SUPPORT = Symbol("PAYOUT_SUPPORT");

@Injectable()
export class PayoutSupportService implements PayoutSupport {
  constructor(
    @Inject(PAYOUTS_REPOSITORY) private readonly repository: PayoutsRepository,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Inject(PayoutLock) private readonly lock: PayoutLockPort,
    @Inject(PayoutNotices) private readonly notices: Pick<PayoutNotices, "paid">,
  ) {}

  async facts(input: OperationInputOf<"payout">, now: Date, operationId?: string): Promise<PayoutFacts> {
    return await loadPayoutFacts(this.repository, this.settings, input, now, operationId);
  }

  async exclusive<T>(period: string, work: () => Promise<T>): Promise<T> {
    return await this.lock.run(period, work);
  }

  async announcePaid(operationId: string, input: OperationInputOf<"payout">): Promise<void> {
    await this.notices.paid(operationId, input);
  }
}
