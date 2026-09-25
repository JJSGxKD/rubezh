import { z } from "zod/mini";
import { apiRequest, type ApiFailure, type ApiRequest, type ApiResult } from "./api-request";
import { useProgress } from "./progress";
import { useShell } from "./shell";
import { loadWallet } from "./wallet-api";

/**
 * Уровень аккаунта и награда за забег (docs/35-stage4-plan.md, WP4). Награду
 * считает сервер заданием очереди, после ответа на итог, — поэтому экран
 * итогов спрашивает её несколько раз с растущей паузой, пока она не
 * посчитана. Не дождался — не беда: монеты всё равно лягут в кошелёк, и
 * шапка покажет их при следующем запросе.
 *
 * Сборка без авторизации (MAX, VK, тесты) ничего не спрашивает: награды
 * живут на сервере.
 *
 * Модуль грузится лениво — после забега и при открытии профиля; состояние,
 * которое читают экраны, — в `progress.ts`.
 */

const progressSchema = z.object({
  level: z.number(),
  xp: z.number(),
  xpIntoLevel: z.number(),
  xpForNext: z.nullable(z.number()),
  nextReward: z.nullable(z.object({ coins: z.number(), gems: z.number() })),
});

const rewardSchema = z.union([
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("none"), reason: z.string() }),
  z.object({
    status: z.literal("granted"),
    coins: z.number(),
    coinsCapped: z.boolean(),
    xp: z.number(),
    levelBefore: z.number(),
    levelAfter: z.number(),
    progress: progressSchema,
  }),
]);

export type ProgressView = z.infer<typeof progressSchema>;
export type RunRewardView = z.infer<typeof rewardSchema>;

export interface ProgressApi {
  progress(): Promise<ApiResult<ProgressView>>;
  reward(runId: string): Promise<ApiResult<RunRewardView>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createProgressApi(request: ApiRequest = apiRequest): ProgressApi {
  return {
    progress: () => request("/api/v1/progress", progressSchema, { method: "GET" }),
    reward: (runId) => request(`/api/v1/progress/runs/${encodeURIComponent(runId)}`, rewardSchema, { method: "GET" }),
  };
}

/**
 * Паузы между вопросами о награде, мс. Обычно задание очереди успевает к
 * первому: забег — три короткие транзакции. Хвост — на волну после поста в
 * канале, когда очередь длиннее; дольше двадцати секунд экран не ждёт.
 */
export const REWARD_POLL_DELAYS_MS = [600, 1_200, 2_500, 5_000, 10_000] as const;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Уровень и кошелёк — при запуске, одним ленивым модулем: первой загрузке
 * хватает одного динамического импорта вместо двух.
 */
export async function loadAccountState(): Promise<void> {
  await Promise.all([loadProgress(), loadWallet()]);
}

export async function loadProgress(api?: ProgressApi): Promise<ApiFailure | null> {
  if (api === undefined && useShell.getState().capabilities.auth === undefined) return "disabled";
  const response = await (api ?? createProgressApi()).progress();
  if (!response.ok) return response.failure;
  useProgress.setState({ progress: response.data });
  return null;
}

export async function awaitReward(runId: string, options: { api?: ProgressApi; sleep?: (ms: number) => Promise<void> } = {}): Promise<RunRewardView | null> {
  if (options.api === undefined && useShell.getState().capabilities.auth === undefined) return null;
  const api = options.api ?? createProgressApi();
  const sleep = options.sleep ?? wait;
  const setReward = (reward: RunRewardView) => useProgress.setState((state) => ({ rewards: { ...state.rewards, [runId]: reward } }));
  setReward({ status: "pending" });

  for (const delay of REWARD_POLL_DELAYS_MS) {
    await sleep(delay);
    const response = await api.reward(runId);
    // Сеть моргнула — спросим на следующем шаге; отказ сервера повтором не лечится.
    if (!response.ok) {
      if (response.failure === "offline" || response.failure === "unavailable") continue;
      break;
    }
    if (response.data.status === "pending") continue;
    setReward(response.data);
    if (response.data.status === "granted") {
      useProgress.setState({ progress: response.data.progress });
      // Монеты уже в кошельке — шапка должна показать их сразу, а не при
      // следующем запуске.
      void loadWallet();
    }
    return response.data;
  }
  // Не дождались: блок награды на экране гаснет, монеты придут и так.
  useProgress.setState((state) => {
    const rewards = { ...state.rewards };
    delete rewards[runId];
    return { rewards };
  });
  return null;
}
