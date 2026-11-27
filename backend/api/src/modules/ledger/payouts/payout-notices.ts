import { Inject, Injectable, Logger } from "@nestjs/common";
import { formatMinor, toMinor } from "@bh/ledger";
import { NotificationsService } from "../../notifications/notifications.service.js";
import { currencySpec } from "../ledger-currencies.js";
import type { OperationInputOf } from "../operations/operation-input.js";
import { parseSnapshot } from "../periods/period-snapshot.js";
import { FinanceChat, type FinanceChatPort } from "./finance-chat.js";
import { parsePayee } from "./payee.js";
import { db } from "./payout-facts.js";
import { PAYOUTS_REPOSITORY, type PayoutsRepository } from "./payouts.repository.js";

/**
 * Сообщения участнику о его отчёте и выплате (docs/37-accounting.md §13, Р222, tasks/T-0469): «отчёт готов», «выплачено»
 * и «отчёт отозван на пересчёт» — уведомлениями игрока (`NotificationsService`: лента и дубль в бота по правилам вида), а
 * спор участника — сообщением в поток «Бухгалтерия». Одно событие — одно сообщение: ключ уведомления несёт месяц,
 * аккаунт и номер раза закрытия (у выплаты — операцию), поэтому повтор не пишет второго.
 *
 * **Не бросает и не блокирует решение.** Закрытие, снятие закрытия и выплата уже записаны: упавшее сообщение — запись в
 * логе, а не отказ запроса. Исход — число отправленных (или `true`/`false` у выплаты), чтобы тест и журнал видели, дошло ли.
 */

const RUB = currencySpec("RUB");

@Injectable()
export class PayoutNotices {
  private readonly logger = new Logger("ledger-payouts");

  constructor(
    @Inject(NotificationsService) private readonly notifications: Pick<NotificationsService, "notify">,
    @Inject(PAYOUTS_REPOSITORY) private readonly repository: PayoutsRepository,
    @Inject(FinanceChat) private readonly chat: FinanceChatPort,
  ) {}

  /** Месяц закрыт: участникам с долгом — «отчёт готов» с их суммой. Раз закрытия входит в ключ: после снятия закрытия отчёт новый. */
  async reportReady(period: string, round: number, now: Date = new Date()): Promise<number> {
    try {
      const row = await db(this.repository.period(period));
      if (row === null || row.status !== "closed" || row.snapshot === null) return 0;
      let sent = 0;
      for (const payout of parseSnapshot(row.snapshot).rub.payouts) {
        const minor = BigInt(payout.rubMinor);
        if (minor <= 0n) continue;
        const delivered = await this.notifications.notify({
          accountId: payout.accountId,
          kind: "finance_report",
          payload: { period, state: "ready", amountRub: formatMinor(minor, RUB), reason: null },
          dedupeKey: `finance:report:${period}:${payout.accountId}:${String(round)}`,
          at: now,
        });
        if (delivered) sent += 1;
      }
      return sent;
    } catch (error: unknown) {
      this.warn("report_ready_failed", period, error);
      return 0;
    }
  }

  /** Закрытие снято: тем, кому отчёт отправляли (по проводкам закрытия этого раза), — «отчёт отозван» с причиной. */
  async recalled(period: string, round: number, reason: string, now: Date = new Date()): Promise<number> {
    try {
      let sent = 0;
      for (const accountId of await db(this.repository.closeRecipients(period, round))) {
        const delivered = await this.notifications.notify({
          accountId,
          kind: "finance_report",
          payload: { period, state: "recalled", amountRub: null, reason: reason.trim().slice(0, 500) },
          dedupeKey: `finance:report:${period}:${accountId}:${String(round)}:recalled`,
          at: now,
        });
        if (delivered) sent += 1;
      }
      return sent;
    } catch (error: unknown) {
      this.warn("recalled_failed", period, error);
      return 0;
    }
  }

  /** Выплата проведена: участнику — «выплачено» с суммой. Владельцу, налогу и займу не пишем: это не про участника. */
  async paid(operationId: string, input: OperationInputOf<"payout">, now: Date = new Date()): Promise<boolean> {
    try {
      const payee = parsePayee(input.payee);
      if (payee?.kind !== "stakeholder") return false;
      return await this.notifications.notify({
        accountId: payee.accountId,
        kind: "finance_payout",
        payload: { period: input.period, amountRub: formatMinor(toMinor(input.amount, RUB), RUB) },
        dedupeKey: `finance:payout:${operationId}`,
        at: now,
      });
    } catch (error: unknown) {
      this.warn("paid_failed", operationId, error);
      return false;
    }
  }

  /** Участник оспорил отчёт: команде — в поток «Бухгалтерия», с именем и его словами. */
  async disputed(period: string, accountId: string, comment: string): Promise<void> {
    let name = accountId;
    try {
      name = (await db(this.repository.names([accountId]))).get(accountId) ?? accountId;
    } catch (error: unknown) {
      this.warn("name_unread", period, error);
    }
    await this.chat.send([`⚠️ Участник ${name} оспаривает отчёт за ${period}: «${comment}»`, "Выплата ему — только по решению владельца с причиной: панель → «Бухгалтерия» → «Выплаты»."].join("\n"));
  }

  private warn(event: string, target: string, error: unknown): void {
    this.logger.warn(JSON.stringify({ module: "ledger-payouts", event, target, reason: error instanceof Error ? error.message : "unknown" }));
  }
}
