import { purchaseState, type PlayerCard } from "../../api/players";
import type { Restriction } from "../../api/restrictions";
import { difficultyTitle } from "../../api/review";
import { formatDuration, formatNumber, plural } from "../../format";

/**
 * Правила карточки игрока вкладками (tasks/T-0054, docs/29-admin-panel.md §2):
 * что на вкладках, какие числа на них и что на «Сводке». Без React — чтобы
 * проверяться тестом на собранной карточке.
 */

export const CARD_TABS = [
  { id: "summary", title: "Сводка" },
  { id: "runs", title: "Забеги" },
  { id: "purchases", title: "Покупки" },
  { id: "wallet", title: "Кошелёк" },
  { id: "friends", title: "Друзья" },
  { id: "restrictions", title: "Ограничения" },
] as const;

export type CardTab = (typeof CARD_TABS)[number]["id"];

/** Вкладка из адреса; нет или чужая — «Сводка». */
export function cardTabOf(tab: string | undefined): CardTab {
  return CARD_TABS.find((candidate) => candidate.id === tab)?.id ?? "summary";
}

/** Числа на вкладках — что ждёт поддержку; нулей нет. */
export function tabCounts(card: PlayerCard, active: readonly Restriction[]): Partial<Record<CardTab, number>> {
  const counts: Partial<Record<CardTab, number>> = {};
  const notDelivered = (card.purchases ?? []).filter((purchase) => purchaseState(purchase).label === "не выдан").length;
  if (notDelivered > 0) counts.purchases = notDelivered;
  const current = active.filter((row) => row.state === "active").length;
  if (current > 0) counts.restrictions = current;
  return counts;
}

/** Цепочка вех в «Сводке» — шесть из девяти, коротко. */
export const MILESTONE_CHAIN = [
  ["enteredAt", "Вход"],
  ["firstRunStartedAt", "1-й забег"],
  ["runs5At", "5 забегов"],
  ["returnedD1At", "D1"],
  ["returnedD7At", "D7"],
  ["firstPurchaseAt", "Покупка"],
] as const;

/** Порядок сложностей от самой трудной: лучший забег показывается на ней. */
const HARDEST_FIRST = ["hard", "normal", "easy"];

/** Лучший забег — на самой трудной сложности, где он есть: hard, normal, easy, затем прочие. */
export function bestRun(best: PlayerCard["runs"]["best"]): { difficulty: string; survivalSec: number; rank: number } | null {
  const others = Object.keys(best).filter((difficulty) => !HARDEST_FIRST.includes(difficulty));
  for (const difficulty of [...HARDEST_FIRST, ...others]) {
    const run = best[difficulty];
    if (run !== null && run !== undefined) return { difficulty, survivalSec: run.survivalSec, rank: run.rank };
  }
  return null;
}

export interface SummaryNumber {
  value: string;
  label: string;
}

/** Цифры «Сводки» — по макету; без права на выручку звёзд и возвратов нет. */
export function summaryNumbers(card: PlayerCard): SummaryNumber[] {
  const numbers: SummaryNumber[] = [{ value: formatNumber(card.runs.runs), label: plural(card.runs.runs, ["забег", "забега", "забегов"]) }];
  const best = bestRun(card.runs.best);
  if (best !== null) numbers.push({ value: formatDuration(best.survivalSec), label: `лучшее, ${difficultyTitle(best.difficulty)} · место ${formatNumber(best.rank)}` });

  if (card.purchases !== null) {
    // Тестовые и возвращённые в звёзды не идут: это не деньги игрока.
    const paid = card.purchases.filter((purchase) => purchase.mode === "live" && purchase.paidAt !== null && purchase.refundedAt === null);
    const stars = paid.reduce((sum, purchase) => sum + purchase.chargedStars, 0);
    const refunds = card.purchases.filter((purchase) => purchase.refundedAt !== null).length;
    numbers.push({ value: formatNumber(stars), label: `⭐ всего, ${formatNumber(paid.length)} ${plural(paid.length, ["покупка", "покупки", "покупок"])}` });
    numbers.push({ value: formatNumber(refunds), label: plural(refunds, ["возврат", "возврата", "возвратов"]) });
  }

  const coins = card.wallet.balances.coins ?? 0;
  const gems = card.wallet.balances.gems ?? 0;
  numbers.push({ value: formatNumber(coins), label: plural(coins, ["монета", "монеты", "монет"]) });
  numbers.push({ value: formatNumber(gems), label: plural(gems, ["самоцвет", "самоцвета", "самоцветов"]) });
  return numbers;
}

/** Аккаунт коротко: первые 4 и последние 4 знака; короче девяти — как есть. */
export function shortId(accountId: string): string {
  return accountId.length <= 8 ? accountId : `${accountId.slice(0, 4)}…${accountId.slice(-4)}`;
}
