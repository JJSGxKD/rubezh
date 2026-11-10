import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { leaderboardSchema, meSchema } from "./runs-api";

/**
 * Клиент недельного сезона (tasks/T-0111, контракт — tasks/archive/T-0110):
 * сезон, пороги и лестница наград, таблица недели и друзей, забор награды за
 * прошлый сезон. Числа наград считает сервер; клиент лишь умножает ступень на
 * множитель сложности и показывает.
 *
 * Модуль грузится вместе с экраном рейтинга — первой загрузке он не нужен.
 *
 * Сервер бывает старше клиента, и поле, которого он не знал, не должно ронять
 * экран: всё, кроме `enabled`, необязательно и приводится к пустому. Сложность —
 * строкой, а не перечислением: ключ незнакомого уровня просто не показывается.
 */

const PREFIX = "/api/v1/seasons";

const rewardSchema = z.object({ coins: z.number(), prestige: z.number() });

const seasonSchema = z.object({
  key: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  secondsLeft: z.number(),
});

const ladderStepSchema = z.object({
  fromPlace: z.number(),
  toPlace: z.number(),
  coins: z.number(),
  prestige: z.number(),
});

const pendingSchema = z.object({
  seasonKey: z.string(),
  kind: z.enum(["place", "threshold"]),
  difficulty: z.nullable(z.string()),
  place: z.nullable(z.number()),
  coins: z.number(),
  prestige: z.number(),
});

const historySchema = z.object({
  seasonKey: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  /** по чему ранжирован сезон: от этого зависит, секунды или очки в `bestSec`; нет поля — по времени */
  scoring: z.optional(z.string()),
  results: z.array(z.object({ difficulty: z.string(), bestSec: z.number(), place: z.number(), boardSize: z.number(), division: z.optional(z.nullable(z.string())) })),
  reward: z.nullable(z.object({ coins: z.number(), prestige: z.number(), claimed: z.boolean() })),
});

const overviewSchema = z.object({
  enabled: z.boolean(),
  startsAt: z.optional(z.nullable(z.string())),
  season: z.optional(z.nullable(seasonSchema)),
  minBoard: z.optional(z.number()),
  thresholds: z.optional(z.record(z.string(), z.number())),
  thresholdPoints: z.optional(z.number()),
  /** по чему ранжирован идущий сезон (T-0294): `time` или `points`; сервер до очков поля не знал */
  scoring: z.optional(z.string()),
  thresholdReward: z.optional(rewardSchema),
  placeLadder: z.optional(z.array(ladderStepSchema)),
  difficultyMul: z.optional(z.record(z.string(), z.number())),
  mine: z.optional(z.record(z.string(), z.nullable(z.number()))),
  minePoints: z.optional(z.record(z.string(), z.nullable(z.number()))),
  /** дивизион игрока на доске сезона (T-0295); ключ — сложность */
  division: z.optional(z.record(z.string(), z.nullable(z.string()))),
  pending: z.optional(z.array(pendingSchema)),
  history: z.optional(z.array(historySchema)),
});

const boardSchema = z.object({
  seasonKey: z.string(),
  difficulty: z.string(),
  /** по чему ранжирована таблица; нет поля — по времени */
  scoring: z.optional(z.string()),
  total: z.number(),
  entries: leaderboardSchema.shape.entries,
  me: z.nullable(meSchema),
});

/** «Твой стиль» (T-0295): оси строками — незнакомую ось экран не показывает, а ответ не отбрасывает. */
const styleSchema = z.object({
  style: z.nullable(z.string()),
  strong: z.nullable(z.string()),
  weak: z.nullable(z.string()),
  axes: z.nullable(z.record(z.string(), z.number())),
  runs: z.number(),
  /** сколько рейтинговых забегов не хватает до стиля; 0 — стиль есть */
  missing: z.number(),
});

const claimSchema = z.object({ claimed: z.boolean(), credited: rewardSchema });

export type SeasonReward = z.infer<typeof rewardSchema>;
export type LadderStep = z.infer<typeof ladderStepSchema>;
export type PendingReward = z.infer<typeof pendingSchema>;
export type SeasonHistoryItem = z.infer<typeof historySchema>;
export type SeasonBoard = z.infer<typeof boardSchema>;
export type SeasonClaim = z.infer<typeof claimSchema>;
export type StyleSummary = z.infer<typeof styleSchema>;
export type BoardScope = "all" | "friends";

/** По чему ранжирован сезон или таблица; всё незнакомое — по времени, как было до очков. */
export type SeasonScoring = "time" | "points";

export function scoringOf(raw: string | undefined): SeasonScoring {
  return raw === "points" ? "points" : "time";
}

/** Сезон, каким его видит экран: поля, которых сервер не прислал, пусты. */
export interface SeasonData {
  startsAt: string | null;
  season: z.infer<typeof seasonSchema> | null;
  minBoard: number;
  thresholds: Record<string, number>;
  /** очки лучшего забега, с которых начинается награда за порог в сезоне по очкам */
  thresholdPoints: number;
  scoring: SeasonScoring;
  thresholdReward: SeasonReward;
  placeLadder: LadderStep[];
  difficultyMul: Record<string, number>;
  mine: Record<string, number | null>;
  /** очки лучшего забега недели по сложности; в сезоне по времени очков нет */
  minePoints: Record<string, number | null>;
  division: Record<string, string | null>;
  pending: PendingReward[];
  history: SeasonHistoryItem[];
}

/** Выключен (или сервер ещё не знает сезонов) — экран остаётся прежним. */
export type SeasonsOverview = { enabled: false } | ({ enabled: true } & SeasonData);

export interface SeasonsApi {
  overview(): Promise<ApiResult<SeasonsOverview>>;
  board(difficulty: string, scope: BoardScope): Promise<ApiResult<SeasonBoard>>;
  claim(seasonKey: string): Promise<ApiResult<SeasonClaim>>;
}

/** Сколько прошлых сезонов показывает экран (сервер отдаёт до восьми). */
export const HISTORY_SHOWN = 8;

function normalized(raw: z.infer<typeof overviewSchema>): SeasonsOverview {
  if (!raw.enabled) return { enabled: false };
  return {
    enabled: true,
    startsAt: raw.startsAt ?? null,
    season: raw.season ?? null,
    minBoard: raw.minBoard ?? 0,
    thresholds: raw.thresholds ?? {},
    thresholdPoints: raw.thresholdPoints ?? 0,
    scoring: scoringOf(raw.scoring),
    thresholdReward: raw.thresholdReward ?? { coins: 0, prestige: 0 },
    placeLadder: raw.placeLadder ?? [],
    difficultyMul: raw.difficultyMul ?? {},
    mine: raw.mine ?? {},
    minePoints: raw.minePoints ?? {},
    division: raw.division ?? {},
    pending: raw.pending ?? [],
    history: (raw.history ?? []).slice(0, HISTORY_SHOWN),
  };
}

/** Клиент «Твоего стиля»: ответ считает сервер по последним десяти рейтинговым забегам. */
export interface StyleApi {
  myStyle(): Promise<ApiResult<StyleSummary>>;
}

const STYLE_PATH = "/api/v1/rating/me/style";

export function createStyleApi(request: ApiRequest = apiRequest): StyleApi {
  return { myStyle: () => request(STYLE_PATH, styleSchema, { method: "GET" }) };
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createSeasonsApi(request: ApiRequest = apiRequest): SeasonsApi {
  return {
    overview: async () => {
      const response = await request(PREFIX, overviewSchema, { method: "GET" });
      if (response.ok) return { ok: true, data: normalized(response.data) };
      // 404: сервер старше сезонов или выключил их — как «enabled: false».
      if (response.failure === "disabled") return { ok: true, data: { enabled: false } };
      return response;
    },
    board: (difficulty, scope) =>
      request(`${PREFIX}/board?difficulty=${encodeURIComponent(difficulty)}&scope=${encodeURIComponent(scope)}`, boardSchema, { method: "GET" }),
    claim: (seasonKey) => request(`${PREFIX}/${encodeURIComponent(seasonKey)}/claim`, claimSchema, { method: "POST" }),
  };
}

/**
 * Забрать все награды сезонов подряд. Сервер выдаёт одну награду на сезон,
 * поэтому за ключ просят один раз; первый отказ останавливает забор — уже
 * начисленное остаётся в сумме, остальное заберётся следующим нажатием.
 */
export async function claimPending(api: SeasonsApi, pending: readonly PendingReward[]): Promise<{ credited: SeasonReward; failed: boolean }> {
  const credited = { coins: 0, prestige: 0 };
  for (const key of new Set(pending.map((entry) => entry.seasonKey))) {
    const response = await api.claim(key);
    if (!response.ok) return { credited, failed: true };
    if (!response.data.claimed) continue;
    credited.coins += response.data.credited.coins;
    credited.prestige += response.data.credited.prestige;
  }
  return { credited, failed: false };
}
