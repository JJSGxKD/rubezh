/**
 * Награда дня в числах (docs/35-stage4-plan.md Р45, §3.14, WP13):
 * `база дня недели × ступень недели × множитель уровня`. VIP-множитель
 * придёт с подпиской (WP10) — в начислении кошелька по причине, а не здесь.
 *
 * **Рабочие числа (О14) — наши**, от экономики забега (`progress-rules.ts`):
 * активный игрок получает из забегов около 1 300 монет в сутки. Неделя
 * награды дня на старте — около тысячи монет, седьмой день — крупнее и с
 * осколками. Самоцветов в награде дня нет (О14): их дают покупка и
 * достижения. Меняются здесь, в карте конфигурации —
 * docs/30-configuration-map.md.
 */

export interface DayBase {
  coins: number;
  /** обычные осколки — только седьмому дню: он должен ощущаться крупнее */
  shards: number;
}

/** День недели награды — по порядку забора, а не по календарю: пропуск дня его не сдвигает. */
export const DAILY_BASE: readonly DayBase[] = [
  { coins: 60, shards: 0 },
  { coins: 80, shards: 0 },
  { coins: 100, shards: 0 },
  { coins: 120, shards: 0 },
  { coins: 150, shards: 0 },
  { coins: 180, shards: 0 },
  { coins: 300, shards: 10 },
];

export const DAYS_IN_WEEK = DAILY_BASE.length;

/**
 * Ступень — сколько недель закрыто; растёт до потолка и не сбрасывается.
 * Пятая неделя и дальше — ×1,6: месяц верности стоит больше, а дальше
 * награда растёт только уровнем.
 */
export const WEEK_STEP_MUL: readonly number[] = [1, 1.15, 1.3, 1.45, 1.6];

/**
 * Уровень аккаунта: +2% за уровень. На высоком уровне расходы больше, и
 * награда не должна становиться ничтожной (Р45); к сотому уровню — почти ×3.
 */
export const LEVEL_MUL_PER_LEVEL = 0.02;

export interface DailyRewardAmount {
  coins: number;
  shards: number;
}

/** Номер дня недели (0…6) и число закрытых недель для дня `dayNumber` — считая с первого, по порядку забора. */
export function dayPosition(dayNumber: number): { dayOfWeek: number; closedWeeks: number } {
  const index = Math.max(0, Math.floor(dayNumber) - 1);
  return { dayOfWeek: index % DAYS_IN_WEEK, closedWeeks: Math.floor(index / DAYS_IN_WEEK) };
}

export function stepMul(closedWeeks: number): number {
  return WEEK_STEP_MUL[Math.min(closedWeeks, WEEK_STEP_MUL.length - 1)] ?? 1;
}

export function levelMul(level: number): number {
  return 1 + LEVEL_MUL_PER_LEVEL * Math.max(0, Math.floor(level) - 1);
}

/**
 * Награда за день `dayNumber` на уровне `level`. Осколки уровнем не
 * растут: их тратят на улучшение предметов, и цена улучшения от уровня
 * аккаунта не зависит.
 */
export function dailyReward(dayNumber: number, level: number): DailyRewardAmount {
  const { dayOfWeek, closedWeeks } = dayPosition(dayNumber);
  const base = DAILY_BASE[dayOfWeek] ?? { coins: 0, shards: 0 };
  const step = stepMul(closedWeeks);
  return { coins: Math.round(base.coins * step * levelMul(level)), shards: Math.round(base.shards * step) };
}
