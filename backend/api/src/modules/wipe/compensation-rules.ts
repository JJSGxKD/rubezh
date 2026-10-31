import { z } from "zod";
import { starsToGems } from "../payments/continue-price.js";
import { WALLET_RESOURCES, type WalletResource } from "../wallet/wallet-types.js";

/**
 * Правила компенсации тестеру (docs/35-stage4-plan.md, Р87, tasks/T-0040).
 *
 * Снимок (`tester-snapshot.ts`) пишет по ним строку компенсации перед вайпом,
 * выдача после вайпа (T-0042) читает `grants` из базы тем же разбором:
 * граница между ними — таблица `tester_compensation`, а данные из базы
 * разбираются схемой, а не приводятся.
 */

/** Бонус тестеру (Р87): 5 самоцветов за уровень аккаунта, не больше 250. */
export const TESTER_BONUS = { gemsPerLevel: 5, maxGems: 250 } as const;

/** Бонус тестеру за уровень аккаунта; уровень ниже первого и нечисловой считаются первым. */
export function bonusGems(level: number): number {
  const whole = Number.isFinite(level) ? Math.floor(level) : 1;
  return Math.min(Math.max(whole, 1) * TESTER_BONUS.gemsPerLevel, TESTER_BONUS.maxGems);
}

/** Звёзды второго шанса → самоцветы по курсу товара, вверх до целого: 10 ⭐ → 12, 3 ⭐ → 4. */
export function compensationGemsForStars(stars: number): number {
  return starsToGems(stars);
}

/** Что начислила покупка — одна строка журнала кошелька. */
export interface CompensationGrant {
  purchaseId: string;
  resource: WalletResource;
  amount: number;
}

/** Выдачи из `grants`: так их читает снимок при записи и выдача компенсации при чтении. */
export const compensationGrantsSchema: z.ZodType<CompensationGrant[]> = z.array(
  z.object({
    purchaseId: z.uuid(),
    resource: z.enum(WALLET_RESOURCES),
    amount: z.number().int().positive(),
  }),
);

const purchaseId = z.uuid();
const resource = z.enum(WALLET_RESOURCES);

/**
 * Разобрать ключ выдачи покупки `purchase:<purchaseId>:<resource>` (так магазин
 * пишет начисление в журнал). Чужой ключ, незнакомый ресурс и сумма, не
 * бывшая начислением, — `null`: такую строку компенсацией не считаем.
 */
export function grantOfKey(key: string, amount: number): CompensationGrant | null {
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const parts = key.split(":");
  if (parts.length !== 3 || parts[0] !== "purchase") return null;
  const id = purchaseId.safeParse(parts[1]);
  const kind = resource.safeParse(parts[2]);
  if (!id.success || !kind.success) return null;
  return { purchaseId: id.data, resource: kind.data, amount };
}
