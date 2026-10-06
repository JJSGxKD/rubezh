/**
 * Ступени бонуса за число друзей (docs/35-stage4-plan.md §3.8): что уже
 * забрано, что можно забрать и до чего ещё расти. Чистый расчёт — правила
 * и числа в `friends-rules.ts`, деньги кладёт сервис через кошелёк.
 */

export interface BonusStep {
  /** сколько засчитанных друзей нужно */
  friends: number;
  coins: number;
}

export type BonusStepState = "claimed" | "ready" | "locked";

export interface BonusView {
  /** засчитанные друзья: сыгравшие хоть один честный забег */
  qualified: number;
  steps: (BonusStep & { state: BonusStepState })[];
  /** монет ждёт забора */
  readyCoins: number;
}

export function bonusView(qualified: number, claimed: readonly number[], steps: readonly BonusStep[]): BonusView {
  const done = new Set(claimed);
  const rows = steps.map((step) => ({ ...step, state: stateOf(step, qualified, done) }));
  return { qualified, steps: rows, readyCoins: rows.filter((row) => row.state === "ready").reduce((sum, row) => sum + row.coins, 0) };
}

/** Ступени, которые можно забрать сейчас, — по возрастанию. */
export function readySteps(qualified: number, claimed: readonly number[], steps: readonly BonusStep[]): BonusStep[] {
  const done = new Set(claimed);
  return steps.filter((step) => stateOf(step, qualified, done) === "ready").sort((left, right) => left.friends - right.friends);
}

function stateOf(step: BonusStep, qualified: number, claimed: ReadonlySet<number>): BonusStepState {
  if (claimed.has(step.friends)) return "claimed";
  return qualified >= step.friends ? "ready" : "locked";
}
