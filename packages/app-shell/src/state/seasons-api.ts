import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { leaderboardSchema } from "./runs-api";

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
  results: z.array(z.object({ difficulty: z.string(), bestSec: z.number(), place: z.number(), boardSize: z.number() })),
  reward: z.nullable(z.object({ coins: z.number(), prestige: z.number(), claimed: z.boolean() })),
});

const overviewSchema = z.object({
  enabled: z.boolean(),
  startsAt: z.optional(z.nullable(z.string())),
  season: z.optional(z.nullable(seasonSchema)),
  minBoard: z.optional(z.number()),
  thresholds: z.optional(z.record(z.string(), z.number())),
  thresholdReward: z.optional(rewardSchema),
  placeLadder: z.optional(z.array(ladderStepSchema)),
  difficultyMul: z.optional(z.record(z.string(), z.number())),
  mine: z.optional(z.record(z.string(), z.nullable(z.number()))),
  pending: z.optional(z.array(pendingSchema)),
  history: z.optional(z.array(historySchema)),
});

const boardSchema = z.object({
  seasonKey: z.string(),
  difficulty: z.string(),
  total: z.number(),
  entries: leaderboardSchema.shape.entries,
  me: z.nullable(z.object({ rank: z.number(), survivalSec: z.number() })),
});

const claimSchema = z.object({ claimed: z.boolean(), credited: rewardSchema });

export type SeasonReward = z.infer<typeof rewardSchema>;
export type LadderStep = z.infer<typeof ladderStepSchema>;
export type PendingReward = z.infer<typeof pendingSchema>;
export type SeasonHistoryItem = z.infer<typeof historySchema>;
export type SeasonBoard = z.infer<typeof boardSchema>;
export type SeasonClaim = z.infer<typeof claimSchema>;
export type BoardScope = "all" | "friends";

/** Сезон, каким его видит экран: поля, которых сервер не прислал, пусты. */
export interface SeasonData {
  startsAt: string | null;
  season: z.infer<typeof seasonSchema> | null;
  minBoard: number;
  thresholds: Record<string, number>;
  thresholdReward: SeasonReward;
  placeLadder: LadderStep[];
  difficultyMul: Record<string, number>;
  mine: Record<string, number | null>;
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
    thresholdReward: raw.thresholdReward ?? { coins: 0, prestige: 0 },
    placeLadder: raw.placeLadder ?? [],
    difficultyMul: raw.difficultyMul ?? {},
    mine: raw.mine ?? {},
    pending: raw.pending ?? [],
    history: (raw.history ?? []).slice(0, HISTORY_SHOWN),
  };
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
