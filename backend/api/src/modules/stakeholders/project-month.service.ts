import { Decimal } from "@bh/fx";
import { Inject, Injectable } from "@nestjs/common";
import { DomainError, ForbiddenError, ValidationError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { FxService } from "../fx/fx.service.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { monthsFromFirst, nextMonth, projectMonth, type ProjectMonth, type ProjectMonthRate } from "./project-month.js";
import { PROJECT_MONTH_REPOSITORY, type ProjectMonthRepository } from "./project-month.repository.js";
import { MAX_SHARE_BP, monthKey, parseMonth, shareAt } from "./stakeholder-rules.js";
import { STAKEHOLDERS_REPOSITORY, type StakeholdersRepository, type StoredShare } from "./stakeholders.repository.js";

/**
 * Кабинет «Мой проект» (docs/35-stage4-plan.md Р218, tasks/T-0453): месяц проекта глазами смотрящего — его доля,
 * участники, выручка живыми оплатами, холд и черновик части. Права проверяются здесь, а не на маршруте: смотреть
 * могут и участник (`revenue.split.own.view`), и финансы (`revenue.split.view`), а один `@RequirePermission`
 * выразил бы только одно из них.
 */

/** Месяц раньше первой оплаты или позже текущего: показывать нечего, а пустой отчёт ввёл бы в заблуждение. */
export class ProjectMonthOutOfRangeError extends DomainError {
  constructor() {
    super("project_month_out_of_range", "Этого месяца в проекте нет: он раньше первой оплаты или ещё не наступил", 400);
  }
}

export type ViewerRole = "stakeholder" | "owner" | "finance";

export interface MyProjectView {
  /** `ГГГГ-ММ` */
  month: string;
  /** от первого месяца оплат до текущего, новые сверху */
  months: string[];
  viewer: {
    role: ViewerRole;
    /** доля смотрящего на месяц; у финансов без доли — `null` */
    sharePercent: number | null;
    /** месяц, с которого действует доля участника; у владельца и финансов — `null` */
    shareFrom: string | null;
  };
  /** доли участников на месяц, без нулевых, большая доля выше */
  participants: { name: string; sharePercent: number; me: boolean }[];
  /** 100 % минус доли участников на месяц */
  ownerSharePercent: number;
  /** курсы, по которым посчитаны суммы; `null` — курса выплаты звезды или рубля нет */
  rates: { starUsd: string; usdRub: string; at: string } | null;
  project: ProjectMonth;
}

const DB_TIMEOUT_MS = 5_000;
/** Значащих цифр курса в ответе: хватает копейке на любой сумме проекта, и это то, что показывает панель курсов. */
const RATE_DIGITS = 12;

@Injectable()
export class ProjectMonthService {
  constructor(
    private readonly roles: RolesService,
    @Inject(STAKEHOLDERS_REPOSITORY) private readonly shares: StakeholdersRepository,
    @Inject(PROJECT_MONTH_REPOSITORY) private readonly months: ProjectMonthRepository,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    private readonly fx: FxService,
  ) {}

  async month(actor: AccountRef, requested: string | undefined, now = new Date()): Promise<MyProjectView> {
    const granted = await this.roles.permissions(actor);
    const isOwner = granted.has("stakeholders.manage");
    const isStakeholder = granted.has("revenue.split.own.view");
    if (!isOwner && !isStakeholder && !granted.has("revenue.split.view")) throw new ForbiddenError("Недостаточно прав");

    const current = monthKey(now);
    const month = requested ?? current;
    const start = this.monthStart(month);
    const available = monthsFromFirst((await this.db(this.months.firstPaidMonth())) ?? current, current);
    if (!available.includes(month)) throw new ProjectMonthOutOfRangeError();

    const [purchases, history, participants, rates] = await Promise.all([
      this.db(this.months.purchases(start, parseMonth(nextMonth(month)))),
      this.db(this.shares.history()),
      this.db(this.shares.participants()),
      this.rates(now),
    ]);

    const byAccount = new Map<string, StoredShare[]>();
    for (const row of history) {
      const list = byAccount.get(row.accountId);
      if (list === undefined) byAccount.set(row.accountId, [row]);
      else list.push(row);
    }

    // Остаток владельцу — от всех строк, а не только от попавших в список: сумма не зависит от выборки
    let totalBp = 0;
    for (const rows of byAccount.values()) totalBp += shareAt(rows, month);
    const ownerBp = MAX_SHARE_BP - totalBp;

    const listed = participants
      .map((participant) => ({ accountId: participant.accountId, name: participant.displayName, bp: shareAt(byAccount.get(participant.accountId) ?? [], month) }))
      .filter((entry) => entry.bp > 0)
      // Большая доля выше; при равных — по имени и идентификатору: порядок не прыгает между запросами
      .sort((a, b) => b.bp - a.bp || a.name.localeCompare(b.name, "ru") || (a.accountId < b.accountId ? -1 : 1));

    let role: ViewerRole;
    let shareBp: number | null;
    let shareFrom: string | null = null;
    if (isOwner) {
      role = "owner";
      shareBp = ownerBp;
    } else if (isStakeholder) {
      role = "stakeholder";
      const own = byAccount.get(actor.accountId) ?? [];
      shareBp = shareAt(own, month);
      shareFrom = shareBp > 0 ? this.activeFrom(own, month) : null;
    } else {
      role = "finance";
      shareBp = null;
    }

    return {
      month,
      months: available,
      viewer: { role, sharePercent: shareBp === null ? null : shareBp / 100, shareFrom },
      participants: listed.map((entry) => ({ name: entry.name, sharePercent: entry.bp / 100, me: entry.accountId === actor.accountId })),
      ownerSharePercent: ownerBp / 100,
      rates: rates === null ? null : { starUsd: rates.starUsd.toFixed(), usdRub: rates.usdRub.toFixed(), at: rates.at },
      project: projectMonth({
        purchases,
        holdDays: this.settings.get(SETTINGS.paymentsHoldDaysTelegram),
        now,
        rates: rates === null ? null : { starUsd: rates.starUsd, usdRub: rates.usdRub },
        shareBp,
      }),
    };
  }

  /**
   * Курсы на сейчас без записи снимка: звезда — по курсу выплаты, доллар в рубль — по курсу рубля. Курс текущий и
   * для прошлых месяцев: это черновик, а не итог периода. Нет любого из двух — денежных сумм нет.
   */
  private async rates(now: Date): Promise<(ProjectMonthRate & { at: string }) | null> {
    const snapshot = await this.db(this.fx.peek(now));
    const star = snapshot.payout.get("XTR");
    const ruble = snapshot.rates.get("RUB");
    if (star === undefined || ruble === undefined) return null;
    return {
      starUsd: star.usdPerUnit.toSignificantDigits(RATE_DIGITS),
      // Курс рубля хранится как «долларов за рубль»: рублей за доллар — обратное число
      usdRub: new Decimal(1).div(ruble.usdPerUnit).toSignificantDigits(RATE_DIGITS),
      at: snapshot.takenAt.toISOString(),
    };
  }

  /** Месяц, с которого действует доля на `month`: запись, давшая её. */
  private activeFrom(rows: readonly StoredShare[], month: string): string | null {
    let found: string | null = null;
    for (const row of rows) if (row.fromMonth <= month && (found === null || row.fromMonth > found)) found = row.fromMonth;
    return found;
  }

  private monthStart(month: string): Date {
    try {
      return parseMonth(month);
    } catch (error: unknown) {
      if (error instanceof RangeError) throw new ValidationError("Месяц — в виде ГГГГ-ММ");
      throw error;
    }
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "месяц проекта");
  }
}
