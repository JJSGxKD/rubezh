import type { RunResult } from "@bh/shared-types";
import { z } from "zod/mini";
import { create } from "zustand";
import type { AdWatchResult } from "./ad-watch";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { useRun } from "./run";
import { useRuns } from "./runs";
import { closeOffer } from "./second-chance-offers";

/**
 * Второй шанс за рекламу на экране смерти (docs/35-stage4-plan.md WP11,
 * Р4): можно ли — спрашиваем сервер, продолжение — по досмотренной сессии
 * показа, у VIP — без ролика. Едет в чанке экрана смерти.
 *
 * **Продолжение даёт сервер, а не ответ SDK**, как и у покупки: движку
 * `continueRun` уходит после того, как сервер записал продолжение. Ролик
 * досмотрен, а ответ сервера потерялся — повтор забирает ту же сессию, и
 * второй ролик смотреть не нужно.
 */

const viewSchema = z.union([
  z.object({ status: z.literal("available"), continueNo: z.number(), pass: z.nullable(z.string()) }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);
const claimSchema = z.object({ continueNo: z.number() });

export type AdContinueView = z.infer<typeof viewSchema>;

export interface AdContinueApi {
  view(runId: string): Promise<ApiResult<AdContinueView>>;
  claim(runId: string, sessionId: string): Promise<ApiResult<{ continueNo: number }>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createAdContinueApi(request: ApiRequest = apiRequest): AdContinueApi {
  const path = (runId: string) => `/api/v1/runs/${encodeURIComponent(runId)}/continues/ad`;
  return {
    view: (runId) => request(path(runId), viewSchema, { method: "GET" }),
    claim: (runId, sessionId) => request(path(runId), claimSchema, { method: "POST", body: { sessionId } }),
  };
}

/**
 * Что сказать под кнопкой, когда продолжения не вышло, а попробовать снова
 * можно: `closed` — ролик закрыт раньше конца; `failed` — реклама не
 * загрузилась; `claim_failed` — ролик досмотрен, сервер не ответил: повтор
 * без нового ролика.
 */
export type AdContinueNotice = "closed" | "failed" | "claim_failed";

/**
 * Почему кнопки нет: `daily_cap`, `no_ads_now` и `restricted` (награды за
 * рекламу закрыты ограничением, WP44) игрок видит строкой — он пробовал,
 * вернётся завтра или узнает подробности в профиле; остальное — молча,
 * кнопки просто нет.
 */
export type AdContinueStage =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ready"; pass: boolean; notice: AdContinueNotice | null }
  | { kind: "watching"; pass: boolean }
  | { kind: "unavailable"; reason: string };

export interface AdContinueDeps {
  api: AdContinueApi;
  /** ролик за награду места `second_chance` — или пропуск VIP */
  watch(): Promise<AdWatchResult>;
  /** награда за рекламу выдана — для `ad_reward_claimed` */
  rewarded(source: "ad" | "pass"): void;
  sleep(ms: number): Promise<void>;
}

/** Пауза перед вторым вопросом: старт забега мог ещё уходить из очереди. */
const UNVERIFIED_RETRY_MS = 1_500;

/** Отказы сервера на забор, после которых кнопки больше нет: продолжение взято или забег закрыт. */
const GONE = new Set(["continue_unavailable", "continue_taken", "run_unverified"]);

let deps: AdContinueDeps = {
  api: createAdContinueApi(),
  watch: async () => (await import("./ad-watch")).watchAd("second_chance"),
  rewarded: (source) => void import("./ad-watch").then(({ trackAdReward }) => trackAdReward("second_chance", source)),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function setAdContinueDepsForTests(next: Partial<AdContinueDeps>): void {
  deps = { ...deps, ...next };
}

export interface AdContinueStore {
  stage: AdContinueStage;
  /** забег, чей второй шанс решается: ответы по чужому забегу отбрасываются */
  runId: string | null;
  /** досмотренная, но не забранная сессия — повтор заберёт её без нового ролика */
  watched: { sessionId: string; source: "ad" | "pass" } | null;
  prepare(result: RunResult): Promise<void>;
  watch(): Promise<void>;
  reset(): void;
}

export const useAdContinue = create<AdContinueStore>((set, get) => {
  const current = (runId: string): boolean => get().runId === runId;

  function gone(reason: string): void {
    set({ stage: { kind: "unavailable", reason }, watched: null });
    closeOffer("ad");
  }

  async function check(runId: string, secondTry = false): Promise<void> {
    // Без старта забега на сервере продолжать нечего, а старт мог ещё лежать в очереди.
    await useRuns.getState().flush("continue");
    const answer = await deps.api.view(runId);
    if (!current(runId)) return;
    if (answer.ok) {
      if (answer.data.status === "available") set({ stage: { kind: "ready", pass: answer.data.pass !== null, notice: null } });
      else gone(answer.data.reason);
      return;
    }
    if (answer.code === "run_unverified" && !secondTry) {
      await deps.sleep(UNVERIFIED_RETRY_MS);
      if (current(runId)) await check(runId, true);
      return;
    }
    // Связи нет — рекламу не предлагаем: ролик без сервера не засчитать.
    gone(answer.code ?? answer.failure);
  }

  async function claim(runId: string, pass: boolean, session: { sessionId: string; source: "ad" | "pass" }): Promise<void> {
    const answer = await deps.api.claim(runId, session.sessionId);
    if (!current(runId)) return;
    if (answer.ok) {
      deps.rewarded(session.source);
      set({ stage: { kind: "idle" }, runId: null, watched: null });
      useRun.getState().continueRun(session.source);
      return;
    }
    if (answer.code === "ad_continue_daily_cap") return gone("daily_cap");
    // Ограничение наложили между выдачей и забором. Код строкой, как у
    // соседних отказов: модуль ограничений экрану забега не нужен.
    if (answer.code === "account_restricted") return gone("restricted");
    if (GONE.has(answer.code ?? "")) return gone("used_up");
    if (answer.code === "ad_not_completed") {
      set({ stage: { kind: "ready", pass, notice: "failed" }, watched: null });
      return;
    }
    set({ stage: { kind: "ready", pass, notice: "claim_failed" }, watched: session });
  }

  return {
    stage: { kind: "idle" },
    runId: null,
    watched: null,

    async prepare(result: RunResult): Promise<void> {
      if (get().runId === result.runId) return;
      set({ runId: result.runId, stage: { kind: "checking" }, watched: null });
      await check(result.runId);
    },

    async watch(): Promise<void> {
      const { runId, stage, watched } = get();
      if (runId === null || stage.kind !== "ready") return;
      const pass = stage.pass;
      set({ stage: { kind: "watching", pass } });
      if (watched !== null) return await claim(runId, pass, watched);

      const outcome = await deps.watch();
      if (!current(runId)) return;
      switch (outcome.kind) {
        case "watched":
          return await claim(runId, pass, { sessionId: outcome.sessionId, source: outcome.source });
        case "closed":
          set({ stage: { kind: "ready", pass, notice: "closed" } });
          return;
        case "no_ads":
          return gone("no_ads_now");
        case "restricted":
          return gone("restricted");
        case "cooldown":
        case "failed":
          set({ stage: { kind: "ready", pass, notice: "failed" } });
          return;
      }
    },

    reset(): void {
      set({ stage: { kind: "idle" }, runId: null, watched: null });
    },
  };
});
