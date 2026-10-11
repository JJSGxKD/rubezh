/**
 * Правила экрана друзей (tasks/T-0048): чистые функции без React — порядок
 * экрана, заливка полосы бонуса и то, кому подарит «Подарить всем». Числа и
 * итог решает сервер; здесь только то, что показать.
 */

/** Кому «Подарить всем» подарит сейчас: друзья без подарка за сутки. */
export function giftAllCount(friendIds: readonly string[], sentToday: readonly string[]): number {
  const gifted = new Set(sentToday);
  return friendIds.filter((id) => !gifted.has(id)).length;
}

export interface BonusTrackState {
  /** доля заливки 0..1 */
  fill: number;
  /** на скольких друзьях следующий шаг; `null` — все пройдены */
  next: number | null;
  /** сколько друзей до следующего шага */
  left: number | null;
}

/**
 * Полоса бонуса. Шаги стоят равными промежутками, а не по шкале числа друзей:
 * до 20 друзей первые шаги иначе слиплись бы в точку. Заливка идёт от
 * последнего пройденного шага к следующему пропорционально числу друзей между
 * ними; до первого шага она пуста.
 */
export function bonusTrack(qualified: number, steps: readonly { friends: number }[]): BonusTrackState {
  const passed = steps.filter((step) => step.friends <= qualified).length;
  const upcoming = steps[passed];
  const next = upcoming?.friends ?? null;
  const left = next === null ? null : next - qualified;
  if (steps.length === 0 || next === null) return { fill: steps.length === 0 ? 0 : 1, next, left };
  if (passed === 0 || steps.length === 1) return { fill: 0, next, left };
  const last = steps[passed - 1]?.friends ?? 0;
  const between = (qualified - last) / (next - last);
  return { fill: (passed - 1 + between) / (steps.length - 1), next, left };
}

/** Порядок экрана: друзей нет — крупное приглашение сверху; есть — список первым. */
export function friendsLayout(friendsCount: number): "invite-first" | "list-first" {
  return friendsCount === 0 ? "invite-first" : "list-first";
}
