import { beforeEach, describe, expect, it } from "vitest";
import type { ApiResult } from "../src/state/api-request";
import { useProgress } from "../src/state/progress";
import { REWARD_POLL_DELAYS_MS, awaitReward, type ProgressApi, type ProgressView, type RunRewardView } from "../src/state/progress-api";

/**
 * Награда на экране итогов (docs/35-stage4-plan.md, WP4). Сервер считает её
 * заданием очереди после ответа на итог, поэтому клиент спрашивает несколько
 * раз: проверяется, что он дожидается, не падает от обрыва сети, не ждёт
 * вечно и не спрашивает дальше, когда сервер отказал.
 */

const PROGRESS: ProgressView = { level: 2, xp: 165, xpIntoLevel: 15, xpForNext: 244, nextReward: { coins: 150, gems: 0 } };
const GRANTED: RunRewardView = { status: "granted", coins: 88, coinsCapped: false, xp: 165, levelBefore: 1, levelAfter: 2, progress: PROGRESS };

function scripted(answers: ApiResult<RunRewardView>[]): ProgressApi & { calls: number } {
  const api = {
    calls: 0,
    progress: async (): Promise<ApiResult<ProgressView>> => ({ ok: true, data: PROGRESS }),
    reward: async (): Promise<ApiResult<RunRewardView>> => {
      const answer = answers[Math.min(api.calls, answers.length - 1)] ?? { ok: false, failure: "unavailable" };
      api.calls++;
      return answer;
    },
  };
  return api;
}

const noSleep = async (): Promise<void> => undefined;

describe("награда за забег на экране итогов", () => {
  beforeEach(() => useProgress.setState({ progress: null, rewards: {} }));

  it("спрашивает, пока сервер не посчитает, и обновляет уровень", async () => {
    const api = scripted([{ ok: true, data: { status: "pending" } }, { ok: true, data: { status: "pending" } }, { ok: true, data: GRANTED }]);

    const reward = await awaitReward("run-1", { api, sleep: noSleep });

    expect(reward).toEqual(GRANTED);
    expect(api.calls).toBe(3);
    expect(useProgress.getState().rewards["run-1"]).toEqual(GRANTED);
    expect(useProgress.getState().progress).toEqual(PROGRESS);
  });

  it("пока считается — экран видит «считаем»", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = awaitReward("run-2", { api: scripted([{ ok: true, data: GRANTED }]), sleep: () => gate });

    expect(useProgress.getState().rewards["run-2"]).toEqual({ status: "pending" });
    release();
    await waiting;
    expect(useProgress.getState().rewards["run-2"]).toEqual(GRANTED);
  });

  it("обрыв сети — спрашивает дальше, а не сдаётся", async () => {
    const api = scripted([{ ok: false, failure: "offline" }, { ok: true, data: GRANTED }]);
    expect(await awaitReward("run-3", { api, sleep: noSleep })).toEqual(GRANTED);
  });

  it("не дождался — блок гаснет, а не висит «считаем» вечно", async () => {
    const api = scripted([{ ok: true, data: { status: "pending" } }]);
    expect(await awaitReward("run-4", { api, sleep: noSleep })).toBeNull();
    expect(api.calls).toBe(REWARD_POLL_DELAYS_MS.length);
    expect(useProgress.getState().rewards["run-4"]).toBeUndefined();
  });

  it("сервер отказал — дальше не спрашивает", async () => {
    const api = scripted([{ ok: false, failure: "unauthorized" }]);
    expect(await awaitReward("run-5", { api, sleep: noSleep })).toBeNull();
    expect(api.calls).toBe(1);
  });

  it("награды нет — причина доходит до экрана", async () => {
    const none: RunRewardView = { status: "none", reason: "too_short" };
    expect(await awaitReward("run-6", { api: scripted([{ ok: true, data: none }]), sleep: noSleep })).toEqual(none);
    expect(useProgress.getState().progress).toBeNull();
  });
});
