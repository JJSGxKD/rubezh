import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * VIP в базе (`vip_subscription`, `vip_period`, `vip_daily`). Игровые сутки
 * самоцветов дня считает база — одна граница у всех реплик
 * (`common/game-day.ts`).
 */

export type VipRenewal = "on" | "cancelled" | "failed";
export type VipCanceller = "player" | "game";

export interface VipSubscriptionRow {
  /** первая покупка подписки */
  subscriptionId: string;
  renewal: VipRenewal;
  cancelledBy: VipCanceller | null;
  createdAt: Date;
  /** конец последнего периода этой подписки; `null` — периодов нет */
  until: Date | null;
}

export interface VipState {
  /** конец VIP — самый поздний конец периода; `null` — VIP не было */
  until: Date | null;
  /** подписки аккаунта, свежие первыми */
  subscriptions: VipSubscriptionRow[];
  /** игровые сутки — `ГГГГ-ММ-ДД` по Москве: ключ самоцветов дня */
  today: string;
  /** самоцветы этих суток уже забраны */
  dailyClaimedToday: boolean;
}

export interface PeriodRecord {
  /** оплата, за которую период: первая покупка подписки или её продление */
  purchaseId: string;
  subscriptionId: string;
  accountId: string;
  paidAt: Date;
  periodSec: number;
  at: Date;
}

export interface StoredPeriod {
  startsAt: Date;
  endsAt: Date;
  /** `false` — период за эту оплату уже был: повтор выдачи */
  created: boolean;
}

/** Что осталось от периода после возврата (tasks/T-0023). */
export interface CutPeriod {
  /** подписка периода: её продление выключается */
  subscriptionId: string;
  /** сколько убрано, секунд; 0 — ничего (остаток использован или период уже обрезан) */
  removedSec: number;
  /** конец VIP после отзыва — самый поздний конец периода аккаунта */
  until: Date | null;
}

export const VIP_REPOSITORY = Symbol("VIP_REPOSITORY");

export interface VipRepository {
  state(accountId: string, at: Date): Promise<VipState>;
  /** Конец VIP — самый поздний конец периода; `null` — VIP не было. Один запрос по индексу: его спрашивает каждое начисление с надбавкой */
  until(accountId: string): Promise<Date | null>;
  /**
   * Период за оплату: с конца прежнего, если тот ещё не кончился к оплате,
   * иначе с оплаты. Подписки нет — заводится с продлением `on`; оплата
   * продления возвращает его в `on`, если отмену не записали позже оплаты:
   * площадка списала — значит, на тот момент продлевала.
   */
  addPeriod(record: PeriodRecord): Promise<StoredPeriod>;
  /**
   * Записать продление. Отменённое остаётся за тем, кто отменил первым:
   * повторная отмена его не меняет. `missing` — такой подписки ещё нет:
   * площадка сообщила о ней раньше выдачи.
   */
  setRenewal(subscriptionId: string, renewal: VipRenewal, cancelledBy: VipCanceller | null, at: Date): Promise<"updated" | "unchanged" | "missing">;
  /** Отметить самоцветы суток `day`; `false` — их уже забрали */
  claimDaily(accountId: string, day: string, at: Date): Promise<boolean>;
  /**
   * Убрать неиспользованный остаток периода оплаты `purchaseId` к моменту
   * `at`: конец периода — не позже `max(начало + 1 мс, at)`, а периоды
   * аккаунта после него сдвигаются на убранное время. `null` — периода нет.
   * Повтор даёт `removedSec: 0`. Необязателен только ради подмен VIP в тестах,
   * которым отзыв не нужен; в базе он есть всегда.
   */
  cutPeriod?(purchaseId: string, at: Date): Promise<CutPeriod | null>;
}

/** Сколько подписок аккаунта читать: больше двух бывает, только если игрок годами подписывается заново. */
const SUBSCRIPTIONS_READ = 10;

const stateSchema = z.object({ until: z.date().nullable(), today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), claimed_today: z.boolean() });
const subscriptionSchema = z.object({
  subscription_id: z.uuid(),
  renewal: z.enum(["on", "cancelled", "failed"]),
  cancelled_by: z.enum(["player", "game"]).nullable(),
  created_at: z.date(),
  until: z.date().nullable(),
});
const periodSchema = z.object({ starts_at: z.date(), ends_at: z.date() });
const cutHeadSchema = z.object({ account_id: z.uuid() });
const cutRowSchema = z.object({ subscription_id: z.uuid(), ends_at: z.date(), keep_until: z.date() });
const untilSchema = z.object({ until: z.date().nullable() });

@Injectable()
export class PrismaVipRepository implements VipRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async state(accountId: string, at: Date): Promise<VipState> {
    const [head, subscriptions] = await Promise.all([
      this.prisma.$queryRaw<unknown[]>`
        SELECT
          (SELECT max(ends_at) FROM vip_period WHERE account_id = ${accountId}::uuid) AS until,
          to_char((${at}::timestamptz AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date, 'YYYY-MM-DD') AS today,
          COALESCE((SELECT last_day = (${at}::timestamptz AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date FROM vip_daily WHERE account_id = ${accountId}::uuid), false) AS claimed_today`,
      this.prisma.$queryRaw<unknown[]>`
        SELECT s.subscription_id, s.renewal::text AS renewal, s.cancelled_by::text AS cancelled_by, s.created_at, max(p.ends_at) AS until
        FROM vip_subscription s LEFT JOIN vip_period p ON p.subscription_id = s.subscription_id
        WHERE s.account_id = ${accountId}::uuid
        GROUP BY s.subscription_id
        ORDER BY s.created_at DESC
        LIMIT ${SUBSCRIPTIONS_READ}`,
    ]);
    const row = stateSchema.parse(head[0]);
    return {
      until: row.until,
      today: row.today,
      dailyClaimedToday: row.claimed_today,
      subscriptions: subscriptions.map((raw) => {
        const parsed = subscriptionSchema.parse(raw);
        return { subscriptionId: parsed.subscription_id, renewal: parsed.renewal, cancelledBy: parsed.cancelled_by, createdAt: parsed.created_at, until: parsed.until };
      }),
    };
  }

  async until(accountId: string): Promise<Date | null> {
    const found = await this.prisma.vipPeriod.findFirst({ where: { accountId }, orderBy: { endsAt: "desc" }, select: { endsAt: true } });
    return found?.endsAt ?? null;
  }

  async addPeriod(record: PeriodRecord): Promise<StoredPeriod> {
    return await this.prisma.$transaction(async (tx) => {
      // Периоды игрока выстраиваются в цепочку: две выдачи разом не должны
      // начаться от одного и того же конца.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`vip:${record.accountId}`}))`;
      const [known] = await tx.$queryRaw<unknown[]>`SELECT starts_at, ends_at FROM vip_period WHERE purchase_id = ${record.purchaseId}::uuid`;
      if (known !== undefined) {
        const period = periodSchema.parse(known);
        return { startsAt: period.starts_at, endsAt: period.ends_at, created: false };
      }
      // Оплата продления значит, что на её момент продление было включено.
      // Отмена, записанная позже оплаты, остаётся: выдача могла задержаться
      // в очереди, а игрок — успеть отменить.
      await tx.$executeRaw`
        INSERT INTO vip_subscription (subscription_id, account_id, renewal, cancelled_by, created_at, updated_at)
        VALUES (${record.subscriptionId}::uuid, ${record.accountId}::uuid, 'on', NULL, ${record.at}, ${record.at})
        ON CONFLICT (subscription_id) DO UPDATE SET renewal = 'on', cancelled_by = NULL, updated_at = EXCLUDED.updated_at
        WHERE vip_subscription.updated_at <= ${record.paidAt}::timestamptz`;
      const [inserted] = await tx.$queryRaw<unknown[]>`
        INSERT INTO vip_period (purchase_id, subscription_id, account_id, starts_at, ends_at, created_at)
        SELECT ${record.purchaseId}::uuid, ${record.subscriptionId}::uuid, ${record.accountId}::uuid, start.at, start.at + ${record.periodSec}::int * interval '1 second', ${record.at}
        FROM (SELECT GREATEST(${record.paidAt}::timestamptz, COALESCE(max(ends_at), ${record.paidAt}::timestamptz)) AS at FROM vip_period WHERE account_id = ${record.accountId}::uuid) AS start
        RETURNING starts_at, ends_at`;
      const period = periodSchema.parse(inserted);
      return { startsAt: period.starts_at, endsAt: period.ends_at, created: true };
    });
  }

  async cutPeriod(purchaseId: string, at: Date): Promise<CutPeriod | null> {
    return await this.prisma.$transaction(async (tx) => {
      const [head] = await tx.$queryRaw<unknown[]>`SELECT account_id::text AS account_id FROM vip_period WHERE purchase_id = ${purchaseId}::uuid`;
      if (head === undefined) return null;
      const { account_id: accountId } = cutHeadSchema.parse(head);
      // Тот же замок, что у `addPeriod`: цепочка периодов игрока меняется по одному.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`vip:${accountId}`}))`;
      // Период читается заново под замком: пока ждали, его могли обрезать или сдвинуть.
      // Меньше миллисекунды остаться не может: период нулевой длины база не примет
      // (`vip_period_span_check`), поэтому ещё не начавшийся период сжимается до неё.
      const [found] = await tx.$queryRaw<unknown[]>`
        SELECT subscription_id::text AS subscription_id, ends_at, GREATEST(${at}::timestamptz, starts_at + interval '1 millisecond') AS keep_until
        FROM vip_period WHERE purchase_id = ${purchaseId}::uuid`;
      if (found === undefined) return null;
      const period = cutRowSchema.parse(found);

      // Миллисекунды: колонки хранят их с точностью до миллисекунды, и сумма не расходится.
      const cutMs = Math.max(0, period.ends_at.getTime() - period.keep_until.getTime());
      if (cutMs > 0) {
        await tx.$executeRaw`UPDATE vip_period SET ends_at = ${period.keep_until}::timestamptz WHERE purchase_id = ${purchaseId}::uuid`;
        // Следующие периоды цепочки встают на освободившееся место. Повтор сюда
        // не доходит: у обрезанного периода `cutMs` уже 0.
        await tx.$executeRaw`
          UPDATE vip_period
          SET starts_at = starts_at - ${cutMs}::float8 * interval '1 millisecond', ends_at = ends_at - ${cutMs}::float8 * interval '1 millisecond'
          WHERE account_id = ${accountId}::uuid AND purchase_id <> ${purchaseId}::uuid AND starts_at >= ${period.ends_at}::timestamptz`;
      }
      const [latest] = await tx.$queryRaw<unknown[]>`SELECT max(ends_at) AS until FROM vip_period WHERE account_id = ${accountId}::uuid`;
      return { subscriptionId: period.subscription_id, removedSec: Math.round(cutMs / 1000), until: untilSchema.parse(latest).until };
    });
  }

  async setRenewal(subscriptionId: string, renewal: VipRenewal, cancelledBy: VipCanceller | null, at: Date): Promise<"updated" | "unchanged" | "missing"> {
    const updated = await this.prisma.vipSubscription.updateMany({
      where: { subscriptionId, ...(renewal === "cancelled" ? { renewal: { not: "cancelled" } } : {}) },
      data: { renewal, cancelledBy, updatedAt: at },
    });
    if (updated.count > 0) return "updated";
    return (await this.prisma.vipSubscription.findUnique({ where: { subscriptionId }, select: { subscriptionId: true } })) === null ? "missing" : "unchanged";
  }

  async claimDaily(accountId: string, day: string, at: Date): Promise<boolean> {
    // Строка — одна на аккаунт; сутки сдвигаются только вперёд, поэтому два
    // запроса разом отметят их однажды.
    return (
      (await this.prisma.$executeRaw`
        INSERT INTO vip_daily (account_id, last_day, updated_at)
        VALUES (${accountId}::uuid, ${day}::date, ${at})
        ON CONFLICT (account_id) DO UPDATE SET last_day = EXCLUDED.last_day, updated_at = EXCLUDED.updated_at
        WHERE vip_daily.last_day < EXCLUDED.last_day`) > 0
    );
  }
}
