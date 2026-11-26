import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { withTimeout } from "../../common/with-timeout.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { ShopSku } from "./shop-catalog.js";

/**
 * «Набор хранителя» (docs/35-stage4-plan.md Р155, tasks/T-0245): после первой победы над
 * Рубежом на 48 часов открывается набор — 330 самоцветов и окрас «Хранитель · рассвет» по цене
 * пакета самоцветов, 250 звёзд. Через 48 часов набор уходит навсегда.
 *
 * **Окно считает сервер**, по часам сервера и по времени конца забега, записанному сервером
 * (`run.finished_at`): клиентскому «часы показывают» верить нельзя, а чужая правка телефона
 * окно не растянет. Окно проверяет только заказ: счёт выставляется внутри окна, а оплата,
 * подтверждённая позже (счёт живёт полчаса), выдаётся как обычно — принятые деньги не должны
 * остаться без товара, поэтому выдача окно не смотрит.
 *
 * **Зачёркнутой цены нет** (поправка владельца 24.10.2026): набор стоит как пакет, окрас идёт в
 * подарок, а настоящая прежняя цена бывает только у акции магазина (`shop-promo-rules.ts`) —
 * постоянной полки у набора нет, поэтому акции на него не действуют (`shop.service.ts`).
 */

export const KEEPER_SET_SKU = "keeper_set";

/** Сколько часов набор доступен после первой победы — число из решения владельца, в коде рядом с каталогом. */
export const KEEPER_SET_HOURS = 48;

const HOUR_MS = 3_600_000;
const DB_TIMEOUT_MS = 3_000;

/** Окно набора: открыто ли и до какого момента. `until` — срок, когда победа известна, даже если окно уже закрыто. */
export interface KeeperSetWindow {
  open: boolean;
  until: Date | null;
}

const CLOSED: KeeperSetWindow = { open: false, until: null };

/**
 * Окно набора по моменту первой победы. Победы нет — закрыто; победа плюс 48 часов — срок:
 * ровно в этот момент и позже окно закрыто. Часы реплики, отставшие от записи победы, окно не
 * закрывают: открыто до срока, как бы ни был сдвинут момент «сейчас» назад. Нечитаемая дата
 * (строка базы) — закрыто, а не открыто навсегда.
 */
export function keeperSetWindow(firstWinAt: Date | null, at: Date): KeeperSetWindow {
  if (firstWinAt === null) return CLOSED;
  const start = firstWinAt.getTime();
  const now = at.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(now)) return CLOSED;
  const until = new Date(start + KEEPER_SET_HOURS * HOUR_MS);
  return { open: now < until.getTime(), until };
}

/** Позиция каталога, чья продажа закрыта окном. */
export function isKeeperSet(sku: Pick<ShopSku, "id">): boolean {
  return sku.id === KEEPER_SET_SKU;
}

export const KEEPER_FIRST_WIN_REPOSITORY = Symbol("KEEPER_FIRST_WIN_REPOSITORY");

export interface FirstWinRepository {
  /** Конец самого раннего честного забега с победой над стражем; `null` — победы не было. */
  firstWinAt(accountId: string): Promise<Date | null>;
}

/** Без побед — тесты и сборки, где базы нет: набор никому не открывается. */
export const NO_FIRST_WIN: FirstWinRepository = { firstWinAt: async () => null };

const rowSchema = z.object({ first_win_at: z.date().nullable() });

/**
 * Победа — та же, за которую платится награда ×2 (`progress-rules.ts`: `rubezhPaid`): страж
 * пришёл и пал, вердикт `ok`, читов нет. Забег, который разбор признал нечестным (`annulled`),
 * не считается — окно тогда считается от следующей честной победы. Один запрос по индексу
 * забегов аккаунта.
 */
@Injectable()
export class PrismaFirstWinRepository implements FirstWinRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async firstWinAt(accountId: string): Promise<Date | null> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT MIN(finished_at) AS first_win_at
      FROM run
      WHERE account_id = ${accountId}::uuid
        AND status = 'finished'::"RunStatus"
        AND finished_at IS NOT NULL
        AND verdict = 'ok'::"RunVerdict"
        AND NOT cheats
        AND rubezh_reached
        AND rubezh_cleared_sec IS NOT NULL
        AND review_outcome IS DISTINCT FROM 'annulled'`;
    // Агрегат без группы всегда даёт одну строку; пустого ответа не бывает, но и «нет победы» читается как `null`.
    const [row] = rows;
    return row === undefined ? null : rowSchema.parse(row).first_win_at;
  }
}

/** Окно набора для аккаунта: победа из базы и часы сервера. */
@Injectable()
export class KeeperSet {
  constructor(@Inject(KEEPER_FIRST_WIN_REPOSITORY) private readonly wins: FirstWinRepository) {}

  async window(accountId: string, at: Date): Promise<KeeperSetWindow> {
    return keeperSetWindow(await withTimeout(this.wins.firstWinAt(accountId), DB_TIMEOUT_MS, "первая победа"), at);
  }
}
