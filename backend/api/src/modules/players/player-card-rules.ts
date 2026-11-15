import type { RateLimit } from "../ingest/rate-limiter.js";
import { ITEM_RARITIES } from "../items/item-catalog.js";
import type { FavoriteSummary } from "../achievements/achievement-rules.js";

/**
 * Карточка игрока, правила без базы (docs/35-stage4-plan.md Р47, Р48, tasks/T-0247): отношение
 * смотрящего к игроку, знаки по редкости и правило доски. Сбор ответа — `players.service.ts`.
 */

/** Лимит на смотрящего: карточки открывают тапом по строке, листая рейтинг, — не чаще раза в секунду. */
export const CARD_LIMIT = { scope: "players:card", limit: 60, windowSec: 60 } as const satisfies RateLimit;

/** Сколько знаков карточка показывает у аватара. */
export const EMBLEM_TOP_LIMIT = 5;

/** Как смотрящий связан с игроком карточки. */
export type PlayerRelation = "self" | "friend" | "outgoing" | "incoming" | "none";

export interface RelationState {
  self: boolean;
  friends: boolean;
  /** смотрящий звал игрока, ответа нет */
  outgoing: boolean;
  /** игрок звал смотрящего, ответа нет */
  incoming: boolean;
}

/**
 * Отношение по состоянию: себя ничто не перебивает, дружба сильнее заявок. Встречные заявки в базе
 * не живут (встречная — уже согласие и сразу дружба), но при гонке «входящая» важнее: она
 * предлагает принять, а не ждать.
 */
export function relationOf(state: RelationState): PlayerRelation {
  if (state.self) return "self";
  if (state.friends) return "friend";
  if (state.incoming) return "incoming";
  if (state.outgoing) return "outgoing";
  return "none";
}

/** Знак на карточке: та же форма, что у знака в строке списка. */
export interface CardEmblem {
  id: string;
  title: string;
  /** редкость: шкала предметов и отдельный тон `team` */
  tier: string;
  category: "status" | "season" | "merit";
  season?: number | undefined;
}

/** Редкости от низшей к высшей; «Команда» — выше всех, неизвестная — ниже всех. */
const TIER_ORDER: readonly string[] = [...ITEM_RARITIES, "team"];

/**
 * Лучшие знаки для аватара: по редкости сверху, не больше `EMBLEM_TOP_LIMIT`. Равные по редкости —
 * по id, чтобы порядок не зависел от порядка каталога и не прыгал между открытиями.
 */
export function topEmblems<T extends CardEmblem>(held: readonly T[], limit = EMBLEM_TOP_LIMIT): T[] {
  return [...held].sort((a, b) => TIER_ORDER.indexOf(b.tier) - TIER_ORDER.indexOf(a.tier) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, limit);
}

/**
 * Игрок отдельной доски (скрытое ограничение «Отдельная доска», Р104) не виден тем, кто читает
 * общую: карточка не обходит скрытие, которое держит рейтинг. Полная доска видит всех.
 */
export function isHiddenFrom(viewerBoard: "full" | "common", targetBoard: "full" | "common"): boolean {
  return viewerBoard === "common" && targetBoard === "full";
}

/** Ответ `GET /players/:publicId` — зеркало `PlayerCard` из `packages/shared-types`: держать равными. */
export interface PlayerCard {
  publicId: string;
  name: string;
  photoUrl?: string;
  /** действующий облик; источник обликов недоступен — Хранитель */
  appearance: string;
  /** в кружке аватара фото площадки, а не голова облика */
  avatarPhoto?: true;
  /** знак у имени, как в строках списков */
  emblem?: CardEmblem;
  emblems: { held: number; top: CardEmblem[] };
  level: number;
  /** мощь надетого */
  power: number;
  /** место на доске текущего сезона глазами смотрящего; `null` — сезона или игрока в таблице нет */
  season: { place: number } | null;
  stats: { runs: number; totalKills: number; bestSurvivalSec: number };
  prestige: number;
  favorites: FavoriteSummary[];
  relation: PlayerRelation;
  /** VIP активен; поля нет — нет */
  vip?: true;
}
