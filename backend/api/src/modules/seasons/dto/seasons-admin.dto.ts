import { z } from "zod";
import { DIVISIONS } from "../../rating/division-rules.js";
import { DIFFICULTIES } from "../../runs/run-rules.js";
import { seasonKeyParamSchema } from "./seasons.dto.js";

/**
 * Рейтинг в панели (docs/35-stage4-plan.md Р189, tasks/T-0380): параметры
 * запросов и формы ответов. Запросы разбирает контроллер, ответы сервис
 * проверяет перед отдачей — форма ответа договор с экраном панели (T-0381), и
 * типы не должны разойтись с тем, что собрал запрос.
 *
 * Пределы страниц — только здесь: ни настройки, ни окружения у раздела нет.
 */

const difficulty = z.enum(DIFFICULTIES);
const board = z.enum(["common", "full"]);
const scoring = z.enum(["time", "points"]);
const count = z.number().int().nonnegative();
const division = z.enum(DIVISIONS).nullable();

const limit = (max: number, fallback: number) => z.coerce.number().int().min(1).max(max).default(fallback);

/** Текущие доски: идущая неделя или всё время, общая или отдельная. */
export const boardsQuerySchema = z.object({
  difficulty,
  period: z.enum(["week", "all"]).default("week"),
  board: board.default("common"),
  limit: limit(200, 100),
});
export type BoardsQuery = z.infer<typeof boardsQuerySchema>;

/** Страница архива: сезоны старше `before` (ключ — понедельник), новые сверху. */
export const seasonsQuerySchema = z.object({
  before: seasonKeyParamSchema.optional(),
  limit: limit(52, 20),
});
export type SeasonsQuery = z.infer<typeof seasonsQuerySchema>;

/** Итоги одного сезона по сложности и доске, страницей по местам. */
export const seasonQuerySchema = z.object({
  difficulty,
  board: board.default("common"),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: limit(200, 100),
});
export type SeasonQuery = z.infer<typeof seasonQuerySchema>;

/** Награда за сезон; у награды за порог сложность и место пусты. */
export const seasonRewardViewSchema = z.object({
  kind: z.enum(["place", "threshold"]),
  coins: count,
  prestige: count,
  status: z.enum(["pending", "claimed"]),
  claimedAt: z.string().nullable(),
});
export type SeasonRewardView = z.infer<typeof seasonRewardViewSchema>;

export const boardsViewSchema = z.object({
  period: z.enum(["week", "all"]),
  difficulty,
  board,
  /** по чему ранжирована доска: неделя — по расписанию, всё время — очки */
  scoring,
  /** ключ идущего сезона; `null` — доска всех времён или сезона сейчас нет */
  seasonKey: z.string().nullable(),
  total: count,
  entries: z.array(
    z.object({
      place: count,
      accountId: z.string(),
      name: z.string(),
      /** число доски: очки или секунды, смотря по `scoring` */
      score: z.number(),
      /** время лучшего забега: в доске по времени — само число доски, в доске по очкам — подпись */
      survivalSec: z.number(),
      /** только у недели: дивизион по месту и размеру доски */
      division,
    }),
  ),
});
export type BoardsView = z.infer<typeof boardsViewSchema>;

const seasonCard = z.object({
  key: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  closedAt: z.string(),
  players: count,
  rewarded: count,
  /** по чему ранжирован сезон: от этого зависит, секунды или очки в `best` */
  scoring,
});

export const seasonsPageSchema = z.object({
  seasons: z.array(seasonCard),
  /** ключ для `before` следующей страницы; `null` — старше сезонов нет */
  next: z.string().nullable(),
});
export type SeasonsPage = z.infer<typeof seasonsPageSchema>;

export const seasonViewSchema = z.object({
  season: seasonCard,
  difficulty,
  board,
  total: count,
  rows: z.array(
    z.object({
      place: count,
      accountId: z.string(),
      name: z.string(),
      best: z.number(),
      boardSize: count,
      division,
      reward: seasonRewardViewSchema.nullable(),
    }),
  ),
});
export type SeasonView = z.infer<typeof seasonViewSchema>;

export const playerSeasonsSchema = z.object({
  seasons: z.array(
    z.object({
      key: z.string(),
      startsAt: z.string(),
      scoring,
      results: z.array(
        z.object({
          difficulty,
          best: z.number(),
          place: count,
          boardSize: count,
          division,
          /** есть только у держателя `players.board.restrict`: строка отдельной доски */
          board: board.optional(),
        }),
      ),
      reward: seasonRewardViewSchema.extend({ difficulty: difficulty.nullable(), place: count.nullable() }).nullable(),
    }),
  ),
});
export type PlayerSeasons = z.infer<typeof playerSeasonsSchema>;
