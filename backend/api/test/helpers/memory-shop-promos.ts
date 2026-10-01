import { PROMO_LIMITS, type PromoInput, type PromoProblem, type PromoRow } from "../../src/modules/shop/shop-promo-rules.js";
import type { ShopPromoRepository } from "../../src/modules/shop/shop-promo.repository.js";

const REST_MS = PROMO_LIMITS.restDays * 24 * 3_600_000;

/** Акции магазина в памяти — с той же выборкой «рядом по времени», что и база. */
export class MemoryShopPromoRepository implements ShopPromoRepository {
  readonly rows: PromoRow[] = [];
  /** сколько раз сервис ходил за идущими акциями — так видно кэш */
  currentCalls = 0;

  async current(at: Date, until: Date): Promise<PromoRow[]> {
    this.currentCalls++;
    return this.rows.filter((row) => row.cancelledAt === null && row.endsAt > at && row.startsAt < until).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  }

  async list(limit: number): Promise<PromoRow[]> {
    return [...this.rows].sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime()).slice(0, limit);
  }

  async create(promo: PromoInput & { promoId: string; createdBy: string }, at: Date, check: (nearby: PromoRow[]) => PromoProblem | null): Promise<PromoProblem | null> {
    const from = promo.startsAt.getTime() - REST_MS;
    const to = promo.endsAt.getTime() + REST_MS;
    const problem = check(this.rows.filter((row) => row.sku === promo.sku && row.endsAt.getTime() > from && row.startsAt.getTime() < to));
    if (problem !== null) return problem;
    this.rows.push({ ...promo, createdAt: at, cancelledAt: null, cancelledBy: null });
    return null;
  }

  async cancel(promoId: string, actorAccountId: string, at: Date): Promise<PromoRow | null> {
    const row = this.rows.find((candidate) => candidate.promoId === promoId && candidate.cancelledAt === null && candidate.endsAt > at);
    if (row === undefined) return null;
    row.cancelledAt = at;
    row.cancelledBy = actorAccountId;
    return { ...row };
  }

  /** завести акцию в обход правил — как строка, уже лежащая в базе */
  seed(row: Partial<PromoRow> & Pick<PromoRow, "sku" | "percent" | "startsAt" | "endsAt">): PromoRow {
    const full: PromoRow = { promoId: crypto.randomUUID(), title: null, createdAt: row.startsAt, createdBy: crypto.randomUUID(), cancelledAt: null, cancelledBy: null, ...row };
    this.rows.push(full);
    return full;
  }
}
