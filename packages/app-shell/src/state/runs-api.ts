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
  /** карточка рейтингового забега (tasks/T-0297); чужой закрытый — отказ 404 */
  card(runId: string): Promise<ApiResult<RunCard>>;
  profile(): Promise<ApiResult<RunProfile>>;
}

const PREFIX = "/api/v1/runs";

const difficultySchema = z.enum(DIFFICULTY_IDS);

const startSchema = z.object({ trusted: z.boolean() });

const axisSchema = z.enum(["t", "k", "h", "c", "b"]);

/** Очки в ответе записи забега (T-0293): их читает строка «Очки · стиль» на экране итогов. */
const scoreSchema = z.object({
  points: z.number(),
  axes: z.object({ t: z.number(), k: z.number(), h: z.number(), c: z.number(), b: z.number() }),
  style: axisSchema,
  band: z.string(),
  expectedPoints: z.number(),
});

const finishSchema = z.object({
  bestSurvivalSec: z.number(),
  isNewBest: z.boolean(),
  rank: z.nullable(z.number()),
  recorded: z.boolean(),
  verdict: z.enum(["ok", "suspicious", "rejected"]),
  score: z.optional(scoreSchema),
});

/** Своя строка доски: место и числа лучшего забега; очки, стиль и дивизион — у сервера не старше T-0294. */
export const meSchema = z.object({
  rank: z.number(),
  survivalSec: z.number(),
  points: z.optional(z.nullable(z.number())),
  style: z.optional(z.nullable(z.string())),
  division: z.optional(z.nullable(z.string())),
});

export const leaderboardSchema = z.object({
  difficultyId: difficultySchema,
  entries: z.array(
    z.object({
      rank: z.number(),
      /** лучший забег игрока: по нему строка открывает карточку забега (T-0297); сервер до карточки поля не отдавал */
      runId: z.optional(z.string()),
      name: z.string(),
      photoUrl: z.nullable(z.string()),
      survivalSec: z.number(),
      level: z.number(),
      startingWeaponId: z.string(),
      enemiesKilled: z.number(),
      isMe: z.boolean(),
      tester: z.optional(z.literal(true)),
      /** очки престижа (T-0107); сервер до достижений поля не отдавал */
      prestige: z.optional(z.number()),
      /** победа над стражем рубежа засчитана (T-0121); сервер шлёт только `true` или ничего */
      rubezh: z.optional(z.literal(true)),
      /** очки эффективности (T-0294); сервер до очков поля не отдавал */
      points: z.optional(z.nullable(z.number())),
      /** стиль забега (T-0293) — ось строкой: незнакомую экран просто не рисует */
      style: z.optional(z.nullable(z.string())),
      /** дивизион сезона (T-0295); в «Всё время» его нет */
      division: z.optional(z.nullable(z.string())),
    }),
  ),
  me: z.nullable(meSchema),
  totalPlayers: z.number(),
});

/**
 * Карточка забега (tasks/T-0297): оси против ожидаемого, разбор очков и
 * сборка. Идентификатора аккаунта и времени записи в ответе нет.
 */
export const runCardSchema = z.object({
  runId: z.string(),
  mine: z.boolean(),
  player: z.object({ name: z.string(), photoUrl: z.nullable(z.string()), tester: z.optional(z.literal(true)) }),
  survivalSec: z.number(),
  level: z.number(),
  power: z.nullable(z.number()),
  startingWeaponId: z.string(),
  points: z.number(),
  expectedPoints: z.number(),
  style: axisSchema,
  band: z.string(),
  cap: z.number(),
  axes: z.array(z.object({ axis: axisSchema, index: z.number(), points: z.number(), expectedPoints: z.number() })),
  facts: z.object({
    killsPerMin: z.number(),
    bossKills: z.nullable(z.number()),
    eliteKills: z.nullable(z.number()),
    damageDeltaPct: z.nullable(z.number()),
  }),
  build: z.object({
    weapons: z.array(z.object({ id: z.string(), level: z.number() })),
    passives: z.array(z.object({ id: z.string(), level: z.number() })),
    boosts: z.array(z.string()),
  }),
});

export type RunCard = z.infer<typeof runCardSchema>;

const bestSchema = z.nullable(z.object({ survivalSec: z.number(), rank: z.number() }));

const profileSchema = z.object({
  runs: z.number(),
  totalKills: z.number(),
  totalSurvivalSec: z.number(),
  best: z.object({ easy: bestSchema, normal: bestSchema, hard: bestSchema }),
  recent: z.array(
    z.object({
      runId: z.optional(z.string()),
      difficultyId: difficultySchema,
      survivalSec: z.number(),
      level: z.number(),
      startingWeaponId: z.string(),
      at: z.number(),
    }),
  ),
  // Признак пролога (T-0279): сервер до пролога поля не отдавал.
  prologueDone: z.optional(z.boolean()),
});

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createRunsApi(request: ApiRequest = apiRequest): RunsApi {
  return {
    start: (start) => request(`${PREFIX}/start`, startSchema, { method: "POST", body: start }),
    finish: async (submission) => {
      const answer = await request(PREFIX, finishSchema, { method: "POST", body: submission });
      if (!answer.ok) return answer;
      const { score, ...rest } = answer.data;
      return { ...answer, data: score === undefined ? rest : { ...rest, score } };
    },
    leaderboard: (difficultyId) =>
      request(`${PREFIX}/leaderboard?difficulty=${encodeURIComponent(difficultyId)}`, leaderboardSchema, { method: "GET" }),
    profile: () => request(`${PREFIX}/me`, profileSchema, { method: "GET" }),
    card: (runId) => request(`/api/v1/rating/runs/${encodeURIComponent(runId)}`, runCardSchema, { method: "GET" }),
  };
}
