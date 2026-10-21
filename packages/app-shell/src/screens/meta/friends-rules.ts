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

export type FriendsLoadStatus = "loading" | "failed" | "ready";
export type FriendsLayout = "pending" | "invite-first" | "list-first";

/**
 * Порядок экрана. Пока сервер не ответил, ни крупного приглашения, ни списка:
 * иначе у игрока с друзьями приглашение мелькнуло бы и уступило место списку.
 * Гость ответа не дождётся, а сбой загрузки — уже ответ: у обоих приглашение
 * крупное, как и у тех, у кого друзей нет.
 */
export function friendsLayout(input: { withAccount: boolean; status: FriendsLoadStatus; friendsCount: number }): FriendsLayout {
  if (!input.withAccount) return "invite-first";
  if (input.status === "loading") return "pending";
  return input.friendsCount === 0 ? "invite-first" : "list-first";
}

/**
 * Нужно ли значкам монет место: четырёхзначная сумма шага (1 000 и больше) с
 * значком не умещается рядом с соседней на самой узкой ширине и налезает на
 * неё. Суммы короче — значок помещается всюду и показывается всегда.
 */
export function coinIconsNeedRoom(steps: readonly { coins: number }[]): boolean {
  return steps.some((step) => step.coins >= 1_000);
}

/**
 * Ширина окна, с которой кнопки в строке игрока снова подписаны текстом. У
 * пары (заявка: «Принять» и «Отклонить») порог выше: по замерам PR #354 на 430
 * px с текстом имя сжималось до 56 px, а ширина имени при текстовых кнопках —
 * `W − 374`; 540 px оставляют около 166 px, как у строки с «Подарить» (158 px).
 * Числа продублированы классами Tailwind в `friends-parts.tsx` — их сверяет тест.
 */
export const PEER_TEXT_FROM_PX = { single: 430, pair: 540 } as const;

export type PeerActionKind = "accept" | "decline" | "gift" | "gifted";

export interface PeerActionView {
  /** Ключ подписи: текст на широком экране и `aria-label` на узком. */
  labelKey: string;
  icon: "check" | "x" | "gift";
  /** Значок виден и рядом с текстом (подарки); у заявок он только вместо текста. */
  iconWithText: boolean;
}

/**
 * Какой значок и какая подпись у кнопки в строке игрока. На узком экране
 * кнопки без текста, чтобы имя не сжималось до буквы; подпись для диктора —
 * те же слова, что и текст на широком.
 */
export function peerActionView(kind: PeerActionKind): PeerActionView {
  switch (kind) {
    case "accept":
      return { labelKey: "friends.accept", icon: "check", iconWithText: false };
    case "decline":
      return { labelKey: "friends.decline", icon: "x", iconWithText: false };
    case "gift":
      return { labelKey: "friends.gift", icon: "gift", iconWithText: true };
    case "gifted":
      return { labelKey: "friends.gift.sent", icon: "check", iconWithText: true };
  }
}
