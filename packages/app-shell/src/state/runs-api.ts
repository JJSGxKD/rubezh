import {
  DIFFICULTY_IDS,
  type DifficultyId,
  type Leaderboard,
  type RunFinishResult,
  type RunFinishSubmission,
  type RunProfile,
  type RunStartSubmission,
} from "@bh/shared-types";
import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";

/**
 * Клиент модуля забегов бэкенда (docs/34-stage3-plan.md, WP4): старт, итог,
 * рейтинг и профиль — под аккаунтом игрока.
 */
export interface RunsApi {
  start(start: RunStartSubmission): Promise<ApiResult<{ trusted: boolean }>>;
  finish(submission: RunFinishSubmission): Promise<ApiResult<RunFinishResult>>;
  leaderboard(difficultyId: DifficultyId): Promise<ApiResult<Leaderboard>>;
  profile(): Promise<ApiResult<RunProfile>>;
}

const PREFIX = "/api/v1/runs";

const difficultySchema = z.enum(DIFFICULTY_IDS);

const startSchema = z.object({ trusted: z.boolean() });

const finishSchema = z.object({
  bestSurvivalSec: z.number(),
  isNewBest: z.boolean(),
  rank: z.nullable(z.number()),
  recorded: z.boolean(),
  verdict: z.enum(["ok", "suspicious", "rejected"]),
});

const leaderboardSchema = z.object({
  difficultyId: difficultySchema,
  entries: z.array(
    z.object({
      rank: z.number(),
      name: z.string(),
      photoUrl: z.nullable(z.string()),
      survivalSec: z.number(),
      level: z.number(),
      startingWeaponId: z.string(),
      enemiesKilled: z.number(),
      isMe: z.boolean(),
    }),
  ),
  me: z.nullable(z.object({ rank: z.number(), survivalSec: z.number() })),
  totalPlayers: z.number(),
});

const bestSchema = z.nullable(z.object({ survivalSec: z.number(), rank: z.number() }));

const profileSchema = z.object({
  runs: z.number(),
  totalKills: z.number(),
  totalSurvivalSec: z.number(),
  best: z.object({ easy: bestSchema, normal: bestSchema, hard: bestSchema }),
  recent: z.array(
    z.object({
      difficultyId: difficultySchema,
      survivalSec: z.number(),
      level: z.number(),
      startingWeaponId: z.string(),
      at: z.number(),
    }),
  ),
});

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createRunsApi(request: ApiRequest = apiRequest): RunsApi {
  return {
    start: (start) => request(`${PREFIX}/start`, startSchema, { method: "POST", body: start }),
    finish: (submission) => request(PREFIX, finishSchema, { method: "POST", body: submission }),
    leaderboard: (difficultyId) =>
      request(`${PREFIX}/leaderboard?difficulty=${encodeURIComponent(difficultyId)}`, leaderboardSchema, { method: "GET" }),
    profile: () => request(`${PREFIX}/me`, profileSchema, { method: "GET" }),
  };
}
