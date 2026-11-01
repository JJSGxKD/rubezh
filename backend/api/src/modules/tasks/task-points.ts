/**
 * Очки заданий (docs/39-retention-mechanics.md П2, docs/35-stage4-plan.md Р102,
 * tasks/T-0105): выполненное задание дня и недели даёт очки из каталога, а на
 * полосе дня и недели стоят три ступени с наградой. Здесь — таблица ступеней и
 * чистые функции состояния; база и кошелёк — в сервисе и репозитории.
 */

export const POINT_PERIODS = ["daily", "weekly"] as const;
export type PointsPeriod = (typeof POINT_PERIODS)[number];

export interface PointsReward {
  coins: number;
  gems: number;
  shards: number;
}

export interface PointsStep {
  points: number;
  reward: PointsReward;
}

/**
 * Ступени и награды — стартовые, геймдизайнер калибрует. Таблица в коде, а не в
 * настройках: меняется релизом вместе с балансом очков заданий. Награда —
 * мягкая валюта, самоцветов нет; пороги растут, награды не убывают (проверяет
 * тест). Набор из пяти дневных заданий даёт 100 очков, из шести недельных —
 * 240, поэтому верхняя ступень дня достижима одним набором.
 */
export const POINT_STEPS = {
  daily: [
    { points: 20, reward: { coins: 40, gems: 0, shards: 0 } },
    { points: 50, reward: { coins: 80, gems: 0, shards: 0 } },
    { points: 100, reward: { coins: 150, gems: 0, shards: 3 } },
  ],
  weekly: [
    { points: 150, reward: { coins: 150, gems: 0, shards: 0 } },
    { points: 400, reward: { coins: 300, gems: 0, shards: 5 } },
    { points: 700, reward: { coins: 600, gems: 0, shards: 10 } },
  ],
} as const satisfies Record<PointsPeriod, readonly PointsStep[]>;

export type PointsStepState = "locked" | "ready" | "claimed";

export interface PointsStepView extends PointsStep {
  state: PointsStepState;
}

export interface PointsBar {
  total: number;
  steps: PointsStepView[];
}

export interface PointsView {
  daily: PointsBar;
  weekly: PointsBar;
}

/** Ступень по порогу; порога, которого нет в таблице, нет и в ответе. */
export function stepOf(period: PointsPeriod, points: number): PointsStep | undefined {
  return POINT_STEPS[period].find((step) => step.points === points);
}

/**
 * Состояние ступеней полосы. Забранная остаётся забранной при любом счёте: очки
 * считаются из каталога сейчас, и выключенное задание не должно «отнимать»
 * награду, которую игрок уже получил.
 */
export function stepStates(period: PointsPeriod, total: number, claimed: ReadonlySet<number>): PointsStepView[] {
  return POINT_STEPS[period].map((step) => ({
    points: step.points,
    reward: { ...step.reward },
    state: claimed.has(step.points) ? "claimed" : total >= step.points ? "ready" : "locked",
  }));
}

export function pointsView(totals: Record<PointsPeriod, number>, claims: Record<PointsPeriod, ReadonlySet<number>>): PointsView {
  const bar = (period: PointsPeriod): PointsBar => {
    const total = Math.max(0, totals[period]);
    return { total, steps: stepStates(period, total, claims[period]) };
  };
  return { daily: bar("daily"), weekly: bar("weekly") };
}

/** Сколько ступеней обеих полос готово к забору — прибавка к знаку меню и вкладок. */
export function readyCount(view: PointsView): number {
  return POINT_PERIODS.reduce((sum, period) => sum + view[period].steps.filter((step) => step.state === "ready").length, 0);
}
