import { z } from "zod";
import { DIVISIONS } from "../../rating/division-rules.js";
import { DIFFICULTIES } from "../../runs/run-rules.js";
import { seasonByKey } from "../season-rules.js";

/**
 * Параметры и ответы недельного сезона (tasks/T-0110). Ответы описаны схемой
 * тоже: форма ответа — договор с клиентом (T-0111), и сервис проверяет её
 * перед отдачей, а не надеется на то, что типы не разойдутся с тем, что
 * собрал запрос.
 */

const difficulty = z.enum(DIFFICULTIES);
const count = z.number().int().nonnegative();

export const boardQuerySchema = z.object({
  difficulty,
  scope: z.enum(["all", "friends"]).default("all"),
});

export type BoardQuery = z.infer<typeof boardQuerySchema>;

/** Ключ сезона в пути: только дата-понедельник, остальное не доходит до базы. */
export const seasonKeyParamSchema = z.string().max(10).refine((key) => seasonByKey(key) !== null, { message: "ключ сезона — дата понедельника" });

const reward = z.object({ coins: count, prestige: count });

/** По чему ранжирован сезон: до понедельника перехода (`rating.points-from`) — по времени, дальше по очкам (T-0294). */
const scoring = z.enum(["time", "points"]);

/** Дивизион по доле сезонной доски (T-0295); `null` — рейтингового забега сезона нет, а у старых итогов дивизиона не было. */
const division = z.enum(DIVISIONS).nullable();

const perDifficulty = <T extends z.ZodType>(value: T) => z.record(difficulty, value);

export const overviewSchema = z.object({
  enabled: z.boolean(),
  /** когда начнётся первый сезон; `null` — сезонов нет или первый уже идёт */
  startsAt: z.string().nullable(),
  season: z.object({ key: z.string(), startsAt: z.string(), endsAt: z.string(), secondsLeft: count }).nullable(),
  minBoard: count,
  /** секунды лучшего времени, с которых начинается награда за порог в сезоне по времени */
  thresholds: perDifficulty(z.number()),
  /** очки лучшего забега, с которых начинается награда за порог в сезоне по очкам */
  thresholdPoints: count,
  /** по чему ранжирован идущий сезон; сезонов нет — `time` */
  scoring,
  thresholdReward: reward,
  placeLadder: z.array(z.object({ fromPlace: count, toPlace: count, coins: count, prestige: count })),
  difficultyMul: perDifficulty(z.number()),
  /** время лучшего забега текущей недели (лучшего по очкам в сезоне по очкам); `null` — рейтинговых забегов на сложности нет */
  mine: perDifficulty(z.number().nullable()),
  /** очки лучшего забега недели; `null` — забегов с очками нет, а в сезоне по времени очки в таблицу не идут */
  minePoints: perDifficulty(z.number().nullable()),
  /** дивизион игрока на доске сезона по месту и размеру доски; `null` — забега сезона на сложности нет */
  division: perDifficulty(division),
  pending: z.array(
    z.object({
      seasonKey: z.string(),
      kind: z.enum(["place", "threshold"]),
      difficulty: difficulty.nullable(),
      place: count.nullable(),
      coins: count,
      prestige: count,
    }),
  ),
  history: z.array(
    z.object({
      seasonKey: z.string(),
      startsAt: z.string(),
      endsAt: z.string(),
      /** по чему ранжирован сезон: от этого зависит, секунды или очки в `bestSec` */
      scoring,
      results: z.array(z.object({ difficulty, bestSec: z.number(), place: count, boardSize: count, division })),
      reward: reward.extend({ claimed: z.boolean() }).nullable(),
    }),
  ),
});

export type Overview = z.infer<typeof overviewSchema>;

/** Запись таблицы недели — форма записи вечного рейтинга (`runs-view.service.ts`). */
const boardEntry = z.object({
  rank: count,
  /** лучший забег недели: по нему открывается карточка забега (T-0297); поля нет у записей прошлой сборки */
  runId: z.string().optional(),
  name: z.string(),
  photoUrl: z.string().nullable(),
  /** знак «Тестер»; поля нет — не тестер */
  tester: z.literal(true).optional(),
  /** знак «Меценат» (Р109); поля нет — не поддержал */
  supporter: z.literal(true).optional(),
  /** очки лучшего забега недели; `null` — в сезоне по времени у забега очков нет */
  points: z.number().nullable(),
  /** время того же забега: в сезоне по очкам — подпись, в сезоне по времени — главное число */
  survivalSec: z.number(),
  /** стиль забега (T-0293); `null` — очков нет */
  style: z.string().nullable(),
  /** дивизион строки по её месту и размеру общей таблицы; в таблице друзей — `null`: место среди друзей не место на доске сезона */
  division,
  level: count,
  startingWeaponId: z.string(),
  enemiesKilled: count,
  isMe: z.boolean(),
});

export const boardViewSchema = z.object({
  /** `null` — сезонов нет или первый ещё не начался */
  seasonKey: z.string().nullable(),
  difficulty,
  /** по чему ранжирована таблица; сезона нет — `time` */
  scoring,
  total: count,
  entries: z.array(boardEntry),
  me: z.object({ rank: count, points: z.number().nullable(), survivalSec: z.number(), style: z.string().nullable(), division }).nullable(),
});

export type BoardView = z.infer<typeof boardViewSchema>;

export const claimResultSchema = z.object({ claimed: z.boolean(), credited: reward });

export type ClaimResult = z.infer<typeof claimResultSchema>;
