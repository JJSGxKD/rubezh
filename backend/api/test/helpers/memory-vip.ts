import type {
  PeriodRecord,
  StoredPeriod,
  VipCanceller,
  VipRenewal,
  VipRepository,
  VipState,
  VipSubscriptionRow,
} from "../../src/modules/vip/vip.repository.js";

/**
 * VIP в памяти — для тестов сервиса. Смысл тот же, что у реализации на
 * Postgres: период один на оплату и начинается с конца прежнего; отменённое
 * остаётся за тем, кто отменил первым; самоцветы — раз в сутки. Сутки здесь
 * — по UTC со сдвигом Москвы: база считает их так же.
 */

const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

export function gameDay(at: Date): string {
  return new Date(at.getTime() + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);
}

interface MemorySubscription {
  subscriptionId: string;
  accountId: string;
  renewal: VipRenewal;
  cancelledBy: VipCanceller | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MemoryPeriod {
  purchaseId: string;
  subscriptionId: string;
  accountId: string;
  startsAt: Date;
  endsAt: Date;
}

export class MemoryVipRepository implements VipRepository {
  readonly subscriptions = new Map<string, MemorySubscription>();
  readonly periods = new Map<string, MemoryPeriod>();
  readonly dailyDays = new Map<string, string>();

  async state(accountId: string, at: Date): Promise<VipState> {
    const periods = [...this.periods.values()].filter((period) => period.accountId === accountId);
    const subscriptions: VipSubscriptionRow[] = [...this.subscriptions.values()]
      .filter((item) => item.accountId === accountId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((item) => ({
        subscriptionId: item.subscriptionId,
        renewal: item.renewal,
        cancelledBy: item.cancelledBy,
        createdAt: item.createdAt,
        until: latest(periods.filter((period) => period.subscriptionId === item.subscriptionId)),
      }));
    const today = gameDay(at);
    return { until: latest(periods), subscriptions, today, dailyClaimedToday: this.dailyDays.get(accountId) === today };
  }

  async addPeriod(record: PeriodRecord): Promise<StoredPeriod> {
    const known = this.periods.get(record.purchaseId);
    if (known !== undefined) return { startsAt: known.startsAt, endsAt: known.endsAt, created: false };
    const existing = this.subscriptions.get(record.subscriptionId);
    if (existing === undefined) {
      this.subscriptions.set(record.subscriptionId, {
        subscriptionId: record.subscriptionId,
        accountId: record.accountId,
        renewal: "on",
        cancelledBy: null,
        createdAt: record.at,
        updatedAt: record.at,
      });
    } else if (existing.updatedAt.getTime() <= record.paidAt.getTime()) {
      Object.assign(existing, { renewal: "on", cancelledBy: null, updatedAt: record.at });
    }
    const end = latest([...this.periods.values()].filter((period) => period.accountId === record.accountId));
    const startsAt = new Date(Math.max(record.paidAt.getTime(), end?.getTime() ?? 0));
    const endsAt = new Date(startsAt.getTime() + record.periodSec * 1000);
    this.periods.set(record.purchaseId, { purchaseId: record.purchaseId, subscriptionId: record.subscriptionId, accountId: record.accountId, startsAt, endsAt });
    return { startsAt, endsAt, created: true };
  }

  async setRenewal(subscriptionId: string, renewal: VipRenewal, cancelledBy: VipCanceller | null, at: Date): Promise<"updated" | "unchanged" | "missing"> {
    const row = this.subscriptions.get(subscriptionId);
    if (row === undefined) return "missing";
    if (renewal === "cancelled" && row.renewal === "cancelled") return "unchanged";
    Object.assign(row, { renewal, cancelledBy, updatedAt: at });
    return "updated";
  }

  async claimDaily(accountId: string, day: string): Promise<boolean> {
    const last = this.dailyDays.get(accountId);
    if (last !== undefined && last >= day) return false;
    this.dailyDays.set(accountId, day);
    return true;
  }
}

function latest(periods: readonly MemoryPeriod[]): Date | null {
  return periods.reduce<Date | null>((max, period) => (max === null || period.endsAt > max ? period.endsAt : max), null);
}
