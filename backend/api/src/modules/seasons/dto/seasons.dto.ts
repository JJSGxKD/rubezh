import { z } from "zod";
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

const perDifficulty = <T extends z.ZodType>(value: T) => z.record(difficulty, value);

export const overviewSchema = z.object({
  enabled: z.boolean(),
  /** когда начнётся первый сезон; `null` — сезонов нет или первый уже идёт */
  startsAt: z.string().nullable(),
  season: z.object({ key: z.string(), startsAt: z.string(), endsAt: z.string(), secondsLeft: count }).nullable(),
  minBoard: count,
  /** секунды лучшего времени, с которых начинается награда за порог */
  thresholds: perDifficulty(z.number()),
  thresholdReward: reward,
  placeLadder: z.array(z.object({ fromPlace: count, toPlace: count, coins: count, prestige: count })),
  difficultyMul: perDifficulty(z.number()),
  /** лучшее время текущей недели; `null` — рейтинговых забегов на сложности нет */
  mine: perDifficulty(z.number().nullable()),
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
      results: z.array(z.object({ difficulty, bestSec: z.number(), place: count, boardSize: count })),
      reward: reward.extend({ claimed: z.boolean() }).nullable(),
    }),
  ),
});

export type Overview = z.infer<typeof overviewSchema>;

/** Запись таблицы недели — форма записи вечного рейтинга (`runs-view.service.ts`). */
const boardEntry = z.object({
  rank: count,
  name: z.string(),
  photoUrl: z.string().nullable(),
  /** знак «Тестер»; поля нет — не тестер */
  tester: z.literal(true).optional(),
  survivalSec: z.number(),
  level: count,
  startingWeaponId: z.string(),
  enemiesKilled: count,
  isMe: z.boolean(),
});

export const boardViewSchema = z.object({
  /** `null` — сезонов нет или первый ещё не начался */
  seasonKey: z.string().nullable(),
  difficulty,
  total: count,
  entries: z.array(boardEntry),
  me: z.object({ rank: count, survivalSec: z.number() }).nullable(),
});

export type BoardView = z.infer<typeof boardViewSchema>;

export const claimResultSchema = z.object({ claimed: z.boolean(), credited: reward });

export type ClaimResult = z.infer<typeof claimResultSchema>;
