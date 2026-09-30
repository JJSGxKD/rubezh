import { levelMul } from "../daily/daily-rules.js";
import type { WalletResource } from "../wallet/wallet-types.js";

/**
 * Колесо в числах (docs/35-stage4-plan.md Р45, §3.14, WP13;
 * docs/07-monetization-and-ads.md §7).
 *
 * **Рабочие числа (О14) — наши**, от экономики забега и награды дня: крутка
 * в среднем даёт около сотни монет на первом уровне — меньше дня награды и
 * десятая часть того, что активный игрок получает из забегов за сутки.
 * Колесо — повод зайти, а не заработок.
 *
 * Монетные сектора — **доли базы уровня**: `WHEEL_COIN_BASE × множитель
 * уровня`. Множитель — тот же, что у награды дня (`daily-rules.ts`): обе
 * суточные награды растут с уровнем одинаково (Р45). Осколки уровнем не
 * растут — цена улучшения предмета от уровня аккаунта не зависит.
 *
 * Самоцветов на колесе нет и не будет (Р11, п. 5): антирекламный пакет
 * выдаёт награды рекламных кнопок без ролика, и самоцветы на колесе
 * превратили бы его в покупку случайной донатной валюты. Кошелёк держит то
 * же правило своим потолком — у причины `wheel_reward` самоцветов нет.
 *
 * Бусты и предметы в секторах придут, когда у бустов появится выдача за игру
 * (Р39), а у предметов — выдача по причине: оба — модули локального агента.
 *
 * Меняются здесь, в карте конфигурации — docs/30-configuration-map.md.
 */

export type WheelResource = Extract<WalletResource, "coins" | "shard_common" | "shard_uncommon">;

export type WheelSector =
  /** монеты — доля базы уровня */
  | { resource: "coins"; share: number; weight: number }
  /** осколки — штуки, уровнем не растут */
  | { resource: Exclude<WheelResource, "coins">; amount: number; weight: number };

/** Монет в базе на первом уровне; на сотом — почти втрое больше. */
export const WHEEL_COIN_BASE = 100;

/**
 * Сектора по часовой стрелке от стрелки — в этом порядке их рисует клиент.
 * Вес — целое число: шанс сектора — вес, делённый на сумму. Сумма — сотня,
 * чтобы шанс читался в процентах прямо в таблице. Крупные и мелкие чередуются,
 * иначе колесо выглядит половиной «пусто» и половиной «джекпот».
 */
export const WHEEL_SECTORS: readonly WheelSector[] = [
  { resource: "coins", share: 0.5, weight: 24 },
  { resource: "shard_common", amount: 3, weight: 16 },
  { resource: "coins", share: 1, weight: 22 },
  { resource: "coins", share: 10, weight: 2 },
  { resource: "coins", share: 1.5, weight: 14 },
  { resource: "shard_common", amount: 8, weight: 8 },
  { resource: "coins", share: 2, weight: 10 },
  { resource: "shard_uncommon", amount: 2, weight: 4 },
];

export interface WheelReward {
  resource: WheelResource;
  amount: number;
}

export function totalWeight(sectors: readonly WheelSector[]): number {
  return sectors.reduce((sum, sector) => sum + sector.weight, 0);
}

/**
 * Сектор по броску `roll` — целому от нуля до суммы весов, не включая её.
 * Бросок целый, чтобы шанс сектора был ровно весом, делённым на сумму, без
 * ошибок округления дробей.
 */
export function pickSector(sectors: readonly WheelSector[], roll: number): number {
  let threshold = roll;
  for (let index = 0; index < sectors.length; index++) {
    const weight = sectors[index]?.weight ?? 0;
    if (threshold < weight) return index;
    threshold -= weight;
  }
  throw new RangeError(`бросок ${String(roll)} вне суммы весов ${String(totalWeight(sectors))}`);
}

export function sectorAt(sectors: readonly WheelSector[], index: number): WheelSector {
  const sector = sectors[index];
  if (sector === undefined) throw new RangeError(`сектора ${String(index)} нет`);
  return sector;
}

export function sectorReward(sector: WheelSector, level: number): WheelReward {
  if (sector.resource === "coins") return { resource: "coins", amount: Math.round(WHEEL_COIN_BASE * sector.share * levelMul(level)) };
  return { resource: sector.resource, amount: sector.amount };
}

/** Шанс сектора — доля от единицы; клиент показывает его процентами до крутки. */
export function sectorOdds(sectors: readonly WheelSector[]): number[] {
  const total = totalWeight(sectors);
  return sectors.map((sector) => sector.weight / total);
}
