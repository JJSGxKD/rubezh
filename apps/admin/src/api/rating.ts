import { z } from "zod";
import { formatDuration, formatNumber, plural } from "../format";
import type { AdminApi, ApiResult } from "./client";

/**
 * Рейтинг в панели (docs/35-stage4-plan.md Р189, tasks/T-0380, T-0381):
 * текущие доски, архив недельных сезонов и места игрока по неделям. Формы
 * ответов — договор с `backend/api/src/modules/seasons/dto/seasons-admin.dto.ts`;
 * лишние поля схема пропускает, чтобы новое поле сервера не роняло экран.
 */

export const DIFFICULTIES = ["easy", "normal", "hard"] as const;
export type RatingDifficulty = (typeof DIFFICULTIES)[number];
export type RatingPeriod = "week" | "all";
export type RatingBoard = "common" | "full";
export type Scoring = "time" | "points";

/** Сколько строк за раз просит экран — по умолчанию сервера. */
export const PAGE_SIZE = 100;

export const DIVISION_TITLES: Readonly<Record<string, string>> = { ruby: "Рубин", gold: "Золото", silver: "Серебро", bronze: "Бронза" };
export const PERIOD_TITLES: Readonly<Record<RatingPeriod, string>> = { week: "Неделя", all: "Всё время" };
export const BOARD_TITLES: Readonly<Record<RatingBoard, string>> = { common: "Общая", full: "Полная" };
export const REWARD_TITLES: Readonly<Record<string, string>> = { place: "за место", threshold: "за порог" };

const count = z.number().int().nonnegative();
const difficulty = z.enum(DIFFICULTIES);
const board = z.enum(["common", "full"]);
const scoring = z.enum(["time", "points"]);
const division = z.string().nullable();

const rewardSchema = z.object({
  kind: z.enum(["place", "threshold"]),
  coins: count,
  prestige: count,
  status: z.enum(["pending", "claimed"]),
  claimedAt: z.string().nullable(),
});
export type SeasonReward = z.infer<typeof rewardSchema>;

export const boardsViewSchema = z.object({
  period: z.enum(["week", "all"]),
  difficulty,
  board,
  scoring,
  seasonKey: z.string().nullable(),
  total: count,
  entries: z.array(z.object({ place: count, accountId: z.string(), name: z.string(), score: z.number(), survivalSec: z.number(), division })),
});
export type BoardsView = z.infer<typeof boardsViewSchema>;

const seasonCardSchema = z.object({ key: z.string(), startsAt: z.string(), endsAt: z.string(), closedAt: z.string(), players: count, rewarded: count, scoring });
export type SeasonCard = z.infer<typeof seasonCardSchema>;

export const seasonsPageSchema = z.object({ seasons: z.array(seasonCardSchema), next: z.string().nullable() });
export type SeasonsPage = z.infer<typeof seasonsPageSchema>;

export const seasonViewSchema = z.object({
  season: seasonCardSchema,
  difficulty,
  board,
  total: count,
  rows: z.array(z.object({ place: count, accountId: z.string(), name: z.string(), best: z.number(), boardSize: count, division, reward: rewardSchema.nullable() })),
});
export type SeasonView = z.infer<typeof seasonViewSchema>;

export const playerSeasonsSchema = z.object({
  seasons: z.array(
    z.object({
      key: z.string(),
      startsAt: z.string(),
      scoring,
      results: z.array(z.object({ difficulty, best: z.number(), place: count, boardSize: count, division, board: board.optional() })),
      reward: rewardSchema.extend({ difficulty: difficulty.nullable(), place: count.nullable() }).nullable(),
    }),
  ),
});
export type PlayerSeasons = z.infer<typeof playerSeasonsSchema>;
export type PlayerSeason = PlayerSeasons["seasons"][number];

export interface BoardsQuery {
  difficulty: RatingDifficulty;
  period: RatingPeriod;
  board: RatingBoard;
  limit: number;
}

export interface SeasonQuery {
  difficulty: RatingDifficulty;
  board: RatingBoard;
  offset: number;
  limit: number;
}

export function fetchRatingBoards(api: AdminApi, query: BoardsQuery): Promise<ApiResult<BoardsView>> {
  return api.request("/rating/boards", { query: { difficulty: query.difficulty, period: query.period, board: query.board, limit: query.limit }, schema: boardsViewSchema });
}

/** Страница архива: сезоны старше `before` (ключ), без него — самые новые. */
export function fetchSeasons(api: AdminApi, before: string | null): Promise<ApiResult<SeasonsPage>> {
  return api.request("/rating/seasons", { query: { before: before ?? undefined }, schema: seasonsPageSchema });
}

export function fetchSeason(api: AdminApi, key: string, query: SeasonQuery): Promise<ApiResult<SeasonView>> {
  return api.request(`/rating/seasons/${encodeURIComponent(key)}`, {
    query: { difficulty: query.difficulty, board: query.board, offset: query.offset, limit: query.limit },
    schema: seasonViewSchema,
  });
}

export function fetchPlayerSeasons(api: AdminApi, accountId: string): Promise<ApiResult<PlayerSeasons>> {
  return api.request(`/players/${encodeURIComponent(accountId)}/seasons`, { schema: playerSeasonsSchema });
}

/** Число доски: секунды — временем, очки — числом с «оч.». */
export function scoreText(score: number, mode: Scoring): string {
  return mode === "time" ? formatDuration(score) : `${formatNumber(score)} оч.`;
}

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"] as const;
const WEEK_DAYS = 6;
const DAY_MS = 86_400_000;

/** Неделя сезона по ключу-понедельнику: «2–8 ноября 2026», через границу — «30 ноября – 6 декабря 2026». */
export function weekTitle(key: string): string {
  const start = new Date(`${key}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return key;
  const end = new Date(start.getTime() + WEEK_DAYS * DAY_MS);
  const startMonth = MONTHS[start.getUTCMonth()] ?? "";
  const endMonth = MONTHS[end.getUTCMonth()] ?? "";
  const startDay = String(start.getUTCDate());
  const endDay = String(end.getUTCDate());
  const startYear = String(start.getUTCFullYear());
  const endYear = String(end.getUTCFullYear());
  if (startYear !== endYear) return `${startDay} ${startMonth} ${startYear} – ${endDay} ${endMonth} ${endYear}`;
  if (start.getUTCMonth() !== end.getUTCMonth()) return `${startDay} ${startMonth} – ${endDay} ${endMonth} ${endYear}`;
  return `${startDay}–${endDay} ${endMonth} ${endYear}`;
}

export function divisionTitle(id: string | null): string {
  return id === null ? "—" : (DIVISION_TITLES[id] ?? id);
}

/** «120 монет, 5 престижа · за место»; нули не пишем, пустая награда — прочерк. */
export function rewardText(reward: Pick<SeasonReward, "kind" | "coins" | "prestige">): string {
  const parts = [
    reward.coins > 0 ? `${formatNumber(reward.coins)} ${plural(reward.coins, ["монета", "монеты", "монет"])}` : "",
    reward.prestige > 0 ? `${formatNumber(reward.prestige)} престижа` : "",
  ].filter((part) => part !== "");
  const kind = REWARD_TITLES[reward.kind] ?? reward.kind;
  return parts.length === 0 ? "—" : `${parts.join(", ")} · ${kind}`;
}
