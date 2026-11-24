import { Inject, Injectable } from "@nestjs/common";
import { ForbiddenError, ValidationError } from "../../../common/domain-error.js";
import { RolesService, type AccountRef } from "../../roles/roles.service.js";
import { SETTINGS } from "../../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../../settings/settings.service.js";
import { LedgerPeriodStatusError } from "../periods/period-errors.js";
import { isPeriod } from "../periods/period-rules.js";
import { parseSnapshot, type PeriodSnapshot } from "../periods/period-snapshot.js";
import { LedgerConfirmationPaidError } from "./payout-errors.js";
import { db } from "./payout-facts.js";
import { PayoutLock, type PayoutLockPort } from "./payout-lock.js";
import { PayoutNotices } from "./payout-notices.js";
import { currentConfirmation } from "./payout-rules.js";
import type { ConfirmationStatus, PayoutRecord } from "./payout-types.js";
import { myReportOf, paidTo, statusOf, type MyReportView, type PayoutStatusView } from "./payout-view.js";
import { PAYOUTS_REPOSITORY, type PayoutsRepository } from "./payouts.repository.js";

/**
 * Подтверждение отчёта месяца участником и статус выплат для владельца (docs/37-accounting.md §13, Р222,
 * tasks/T-0469). Участник подтверждает или оспаривает **свой** отчёт закрытого месяца — пока ему не выплачено; выплата
 * проводится операцией «Выплата» (`OperationsService`), а правила «можно ли платить» — в сборщике, поэтому обойти их
 * другим маршрутом нельзя. Суммы — только из снимка закрытия: ничего не пересчитывается на лету. Решение, проверка
 * «не выплачено» и запись идут под замком месяца: выплата и подтверждение не расходятся.
 */

export const CONFIRM_ROLE_PERMISSION = "revenue.split.own.view" as const;
export const COMMENT_MIN = 3;
export const COMMENT_MAX = 1_000;

export interface ConfirmInput {
  decision: ConfirmationStatus;
  comment?: string | undefined;
}

interface ClosedMonth {
  snapshot: PeriodSnapshot;
  closedAt: Date;
}

@Injectable()
export class PayoutsService {
  constructor(
    @Inject(PAYOUTS_REPOSITORY) private readonly repository: PayoutsRepository,
    private readonly roles: RolesService,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    private readonly notices: PayoutNotices,
    @Inject(PayoutLock) private readonly lock: PayoutLockPort,
  ) {}

  /**
   * Участник подтверждает или оспаривает свой отчёт. Спор — с комментарием от трёх знаков; он уходит в аудит и в
   * поток «Бухгалтерия». Пока выплат по участнику нет, решение можно поменять; повтор того же решения — безопасен:
   * ни второй записи, ни второго сообщения. Чужой месяц (доли нет в снимке) — 403, не закрытый — 409.
   */
  async confirm(actor: AccountRef, period: string, input: ConfirmInput, now: Date = new Date()): Promise<MyReportView> {
    assertPeriod(period);
    const comment = normalizedComment(input);
    await this.requireOwnView(actor);
    return await this.lock.run(period, async () => {
      const month = await this.closedMonth(period);
      this.requireShare(month.snapshot, actor.accountId);
      const records = await db(this.repository.payoutsOf(period));
      if (paidTo(records, `stakeholder:${actor.accountId}`) > 0n) throw new LedgerConfirmationPaidError(period);

      const previous = currentConfirmation(await db(this.repository.confirmation(period, actor.accountId)), month.closedAt);
      const repeated = previous !== null && previous.status === input.decision && previous.comment === comment;
      if (!repeated) {
        // Решение не раньше закрытия: расхождение часов процессов не должно сделать свежее решение «старым».
        const decidedAt = now.getTime() >= month.closedAt.getTime() ? now : month.closedAt;
        await db(this.repository.saveConfirmation({ period, accountId: actor.accountId, status: input.decision, comment, decidedAt }));
        await this.roles.audit({
          actorAccountId: actor.accountId,
          action: input.decision === "confirmed" ? "ledger.period.confirm" : "ledger.period.dispute",
          target: period,
          before: previous === null ? {} : { status: previous.status },
          after: { status: input.decision, ...(comment === null ? {} : { comment }) },
        });
        if (input.decision === "disputed" && comment !== null) await this.notices.disputed(period, actor.accountId, comment);
      }
      return await this.reportOf(month, actor.accountId, records);
    });
  }

  /** Свой отчёт закрытого месяца: водопад из снимка, своя строка и решение. */
  async reportFor(actor: AccountRef, period: string): Promise<MyReportView> {
    assertPeriod(period);
    await this.requireOwnView(actor);
    const month = await this.closedMonth(period);
    this.requireShare(month.snapshot, actor.accountId);
    return await this.reportOf(month, actor.accountId, await db(this.repository.payoutsOf(period)));
  }

  /** Выплаты месяца для владельца и финансов: по участнику — долг, решение, выплачено, можно ли платить и почему нет. */
  async status(period: string, now: Date = new Date()): Promise<PayoutStatusView> {
    assertPeriod(period);
    const month = await this.closedMonth(period);
    const [records, confirmations] = await Promise.all([db(this.repository.payoutsOf(period)), db(this.repository.confirmations(period))]);
    const names = await db(this.repository.names(month.snapshot.rub.payouts.map((payout) => payout.accountId)));
    return statusOf({ snapshot: month.snapshot, closedAt: month.closedAt, now, confirmDays: this.settings.get(SETTINGS.financeConfirmDays), records, confirmations, names });
  }

  private async reportOf(month: ClosedMonth, accountId: string, records: readonly PayoutRecord[]): Promise<MyReportView> {
    const period = month.snapshot.period;
    const [confirmation, names] = await Promise.all([db(this.repository.confirmation(period, accountId)), db(this.repository.names([accountId]))]);
    return myReportOf({
      snapshot: month.snapshot,
      closedAt: month.closedAt,
      accountId,
      name: month.snapshot.accounts[accountId] ?? names.get(accountId) ?? accountId,
      records,
      confirmation,
      confirmDays: this.settings.get(SETTINGS.financeConfirmDays),
    });
  }

  /** Участник проекта — тот, у кого право «свой расчёт» (`revenue.split.own.view`); владелец с ним тоже, но долга у него нет. */
  private async requireOwnView(actor: AccountRef): Promise<void> {
    if (!(await this.roles.permissions(actor)).has(CONFIRM_ROLE_PERMISSION)) throw new ForbiddenError("Недостаточно прав");
  }

  /** Долг участнику — в снимке закрытия: нет строки с суммой, значит, в этом месяце его доли нет. */
  private requireShare(snapshot: PeriodSnapshot, accountId: string): void {
    const owed = BigInt(snapshot.rub.payouts.find((payout) => payout.accountId === accountId)?.rubMinor ?? "0");
    if (owed <= 0n) throw new ForbiddenError("В этом месяце у тебя нет доли: подтверждать нечего");
  }

  /** Закрытый месяц со снимком; любой другой — 409: отчёта ещё нет или его отозвали. */
  private async closedMonth(period: string): Promise<ClosedMonth> {
    const row = await db(this.repository.period(period));
    if (row === null || row.status !== "closed" || row.closedAt === null || row.snapshot === null) throw new LedgerPeriodStatusError(period, row?.status ?? "open", "closed");
    return { snapshot: parseSnapshot(row.snapshot), closedAt: row.closedAt };
  }
}

function assertPeriod(period: string): void {
  if (!isPeriod(period)) throw new ValidationError("Месяц должен быть вида ГГГГ-ММ");
}

/** Комментарий: спору он обязателен (от трёх знаков), подтверждению — по желанию; не длиннее тысячи знаков. */
function normalizedComment(input: ConfirmInput): string | null {
  const text = input.comment?.trim() ?? "";
  if (text.length > COMMENT_MAX) throw new ValidationError(`Комментарий — не длиннее ${String(COMMENT_MAX)} знаков`);
  if (input.decision === "disputed" && text.length < COMMENT_MIN) throw new ValidationError(`Чтобы оспорить отчёт, напиши, что не так: от ${String(COMMENT_MIN)} до ${String(COMMENT_MAX)} знаков`);
  return text === "" ? null : text;
}
