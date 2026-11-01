import type { TaskReward } from "../../state/tasks-api";

/**
 * Полоса очков дня и недели (docs/39-retention-mechanics.md П2, tasks/T-0105):
 * чистые правила без экрана. Сервер отдаёт сумму очков и три ступени с
 * состоянием; здесь — доля заполнения, «до награды ещё N очков», число
 * готовых ступеней и места ступеней на полосе.
 */

export type PointsStepState = "locked" | "ready" | "claimed";

export interface PointsStep {
  points: number;
  reward: TaskReward;
  state: PointsStepState;
}

export interface PointsBar {
  total: number;
  steps: readonly PointsStep[];
}

/** Доля 0…1 по самой дальней ступени: полоса полна, когда пройдены все. */
export function barFill(total: number, steps: readonly Pick<PointsStep, "points">[]): number {
  const last = steps.at(-1)?.points ?? 0;
  if (last <= 0) return 0;
  return Math.min(1, Math.max(0, total / last));
}

/** Сколько очков до ближайшей закрытой ступени; пройдены все (готовы или забраны) — `null`. */
export function leftToNext(bar: PointsBar): number | null {
  const next = bar.steps.find((step) => step.state === "locked");
  return next === undefined ? null : Math.max(0, next.points - bar.total);
}

/** Сколько ступеней полосы можно забрать прямо сейчас. */
export function readyIn(bar: PointsBar): number {
  return bar.steps.filter((step) => step.state === "ready").length;
}

/** Места ступеней на полосе — доли 0…1 по самой дальней: последняя на правом краю. */
export function markers(steps: readonly Pick<PointsStep, "points">[]): number[] {
  const last = steps.at(-1)?.points ?? 0;
  return last <= 0 ? [] : steps.map((step) => step.points / last);
}
