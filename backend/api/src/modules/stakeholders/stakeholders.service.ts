import { Inject, Injectable } from "@nestjs/common";
import { ForbiddenError, ValidationError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { StakeholderAccountNotFoundError, StakeholderMonthPastError, StakeholderRoleRequiredError } from "./stakeholder-errors.js";
import { monthKey, overLimit, parseMonth, percentToBp } from "./stakeholder-rules.js";
import { stakeholdersView, type StakeholdersView } from "./stakeholder-view.js";
import { STAKEHOLDERS_REPOSITORY, type StakeholdersRepository } from "./stakeholders.repository.js";

/**
 * Доли участников проекта (docs/35-stage4-plan.md Р217, tasks/T-0452): владелец назначает процент с месяца,
 * участник и финансы видят все доли. Права проверяются здесь, а не на маршруте: чтение открывают два права
 * («или своё, или всех»), а один `@RequirePermission` выразил бы только одно — как у кабинета партнёра.
 */

/** Что приходит в запросе назначения доли; границу уже прошла схема, но сервис не верит вызывающему. */
export interface SetShareBody {
  sharePercent: number;
  /** `ГГГГ-ММ` */
  fromMonth: string;
  note: string;
}

const DB_TIMEOUT_MS = 5_000;

@Injectable()
export class StakeholdersService {
  constructor(
    private readonly roles: RolesService,
    @Inject(STAKEHOLDERS_REPOSITORY) private readonly repository: StakeholdersRepository,
  ) {}

  /**
   * Все участники с долями. Видит тот, у кого есть `revenue.split.view` (владелец, финансы) — с причинами и
   * авторами правок, — или `revenue.split.own.view` (участник): без них, это внутренние записи владельца.
   */
  async list(actor: AccountRef, now = new Date()): Promise<StakeholdersView> {
    const granted = await this.roles.permissions(actor);
    const detailed = granted.has("revenue.split.view");
    if (!detailed && !granted.has("revenue.split.own.view")) throw new ForbiddenError("Недостаточно прав");
    return await this.view(monthKey(now), detailed);
  }

  /**
   * Назначить долю с месяца. Запись на тот же месяц заменяет прежнюю, а доля 0 % — конец участия. Ответ —
   * обновлённый список, как его видит владелец.
   */
  async setShare(actor: AccountRef, accountId: string, body: SetShareBody, now = new Date()): Promise<StakeholdersView> {
    await this.roles.require(actor, "stakeholders.manage");
    const shareBp = this.shareBpOf(body.sharePercent);
    const fromMonth = this.monthOf(body.fromMonth);
    const current = monthKey(now);
    if (fromMonth < current) throw new StakeholderMonthPastError();

    const target = await this.db(this.repository.account(accountId));
    if (target === null) throw new StakeholderAccountNotFoundError();
    if (shareBp > 0 && !target.hasRole) throw new StakeholderRoleRequiredError();

    const result = await this.db(this.repository.setShare({ accountId, fromMonth, shareBp, note: body.note, setBy: actor.accountId, at: now }, overLimit));
    // Причина — в `after`: запись на месяц при замене перезаписывается, и журнал остаётся единственным местом, где прежняя причина сохранилась
    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: "stakeholders.share.set",
      target: accountId,
      before: result.before === null ? null : { fromMonth: result.before.fromMonth, sharePercent: result.before.shareBp / 100 },
      after: { fromMonth: result.after.fromMonth, sharePercent: result.after.shareBp / 100, note: body.note },
    });
    return await this.view(current, true);
  }

  private async view(month: string, detailed: boolean): Promise<StakeholdersView> {
    const [participants, history] = await Promise.all([this.db(this.repository.participants()), this.db(this.repository.history())]);
    return stakeholdersView({ month, participants, history, detailed });
  }

  private shareBpOf(percent: number): number {
    try {
      return percentToBp(percent);
    } catch (error: unknown) {
      if (error instanceof RangeError) throw new ValidationError("Доля — число от 0 до 100, не больше двух знаков после запятой");
      throw error;
    }
  }

  private monthOf(month: string): string {
    try {
      parseMonth(month);
      return month;
    } catch (error: unknown) {
      if (error instanceof RangeError) throw new ValidationError("Месяц — в виде ГГГГ-ММ");
      throw error;
    }
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "доли участников");
  }
}
