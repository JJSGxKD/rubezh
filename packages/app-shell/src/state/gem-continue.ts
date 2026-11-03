import type { RunResult } from "@bh/shared-types";
import { z } from "zod/mini";
import { create } from "zustand";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { useRun } from "./run";
import { useRuns } from "./runs";
import { closeOffer } from "./second-chance-offers";
import { useWallet } from "./wallet";

/**
 * Второй шанс за самоцветы на экране смерти (docs/35-stage4-plan.md Р162,
 * tasks/T-0325): цена и баланс известны до нажатия, нехватка видна на кнопке,
 * продолжение — по ответу сервера. Едет в чанке экрана смерти.
 *
 * **Продолжение даёт сервер, а не нажатие.** Движку `continueRun` уходит после
 * того, как сервер списал самоцветы и записал продолжение. Ответ потерялся —
 * повтор идёт тем же номером и секундой: сервер отдаёт прежний ответ и не
 * списывает второй раз.
 */

const viewSchema = z.union([
  z.object({ status: z.literal("available"), continueNo: z.number(), priceGems: z.number(), balance: z.number() }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);
const receiptSchema = z.object({ continueNo: z.number(), priceGems: z.number(), balance: z.number() });

export type GemContinueView = z.infer<typeof viewSchema>;
export type GemContinueReceipt = z.infer<typeof receiptSchema>;

export interface GemContinueApi {
  view(runId: string, elapsedSec: number): Promise<ApiResult<GemContinueView>>;
  buy(runId: string, continueNo: number, elapsedSec: number): Promise<ApiResult<GemContinueReceipt>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createGemContinueApi(request: ApiRequest = apiRequest): GemContinueApi {
  const path = (runId: string) => `/api/v1/runs/${encodeURIComponent(runId)}/continues/gems`;
  return {
    // Секунда забега в строке запроса — десятичное число без порядка: сервер разбирает его строгим шаблоном.
    view: (runId, elapsedSec) => request(`${path(runId)}?elapsedSec=${elapsedSec.toFixed(3)}`, viewSchema, { method: "GET" }),
    buy: (runId, continueNo, elapsedSec) => request(path(runId), receiptSchema, { method: "POST", body: { continueNo, elapsedSec } }),
  };
}

/** Цена и баланс на момент вопроса. */
export interface GemOffer {
  continueNo: number;
  priceGems: number;
  balance: number;
}

/** Хватает ли самоцветов и сколько не хватает — решение кнопки, а не сервера: покупка с нехваткой не уходит. */
export function gemOffer(offer: GemOffer): { affordable: boolean; shortfall: number } {
  const shortfall = Math.max(0, offer.priceGems - offer.balance);
  return { affordable: shortfall === 0, shortfall };
}

/**
 * - `loading` — узнаём цену;
 * - `ready` — цена известна; `notice: "offline"` — прошлое нажатие не дошло до
 *   сервера, повтор безопасен;
 * - `buying` — запрос на покупку ушёл;
 * - `unavailable` — способа больше нет: сервер сказал «недоступно»,
 *   самоцветов не хватило, продолжение взято другим способом, связи нет.
 */
export type GemContinueStage =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; offer: GemOffer; notice: "offline" | null }
  | { kind: "buying"; offer: GemOffer }
  | { kind: "unavailable"; reason: GemUnavailableReason };

/**
 * `taken` — продолжение взято рекламой или звёздами; `insufficient_funds` —
 * на момент покупки самоцветов не хватило; `not_offered` — связи нет или
 * сервер отверг запрос; остальное — причины сервера (`unverified`,
 * `finished`, `used_up`).
 */
export type GemUnavailableReason = "unverified" | "finished" | "used_up" | "taken" | "insufficient_funds" | "not_offered";

export interface GemContinueDeps {
  api: GemContinueApi;
  sleep(ms: number): Promise<void>;
}

/** Пауза перед вторым вопросом: старт забега мог ещё уходить из очереди. */
const UNVERIFIED_RETRY_MS = 1_500;

let deps: GemContinueDeps = {
  api: createGemContinueApi(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function setGemContinueDepsForTests(next: Partial<GemContinueDeps>): void {
  deps = { ...deps, ...next };
}

/** Забег, чей второй шанс решается: номер и секунда не меняются между повторами. */
interface GemRequest {
  runId: string;
  continueNo: number;
  elapsedSec: number;
}

export interface GemContinueStore {
  stage: GemContinueStage;
  /** ответы по чужому забегу отбрасываются */
  request: GemRequest | null;
  prepare(result: RunResult): Promise<void>;
  buy(): Promise<void>;
  reset(): void;
}

export const useGemContinue = create<GemContinueStore>((set, get) => {
  const current = (request: GemRequest): boolean => get().request === request;

  function gone(reason: GemUnavailableReason): void {
    set({ stage: { kind: "unavailable", reason } });
    closeOffer("gems");
  }

  async function check(request: GemRequest, secondTry = false): Promise<void> {
    // Без старта забега на сервере продолжать нечего, а старт мог ещё лежать в очереди.
    await useRuns.getState().flush("continue");
    const answer = await deps.api.view(request.runId, request.elapsedSec);
    if (!current(request)) return;
    if (answer.ok) {
      if (answer.data.status === "available") {
        const { priceGems, balance } = answer.data;
        // Номер даёт сервер: он знает, какие продолжения уже взяты другими способами.
        const next: GemRequest = { ...request, continueNo: answer.data.continueNo };
        set({ request: next, stage: { kind: "ready", offer: { continueNo: next.continueNo, priceGems, balance }, notice: null } });
      } else {
        gone(unavailableReason(answer.data.reason));
      }
      return;
    }
    if (answer.code === "run_unverified" && !secondTry) {
      await deps.sleep(UNVERIFIED_RETRY_MS);
      if (current(request)) await check(request, true);
      return;
    }
    // Связи нет — самоцветы не предлагаем: без сервера их не списать.
    gone(answer.code === "run_unverified" ? "unverified" : "not_offered");
  }

  return {
    stage: { kind: "idle" },
    request: null,

    async prepare(result: RunResult): Promise<void> {
      if (get().request?.runId === result.runId) return;
      const request: GemRequest = { runId: result.runId, continueNo: result.continues.length + 1, elapsedSec: result.survivalSec };
      set({ request, stage: { kind: "loading" } });
      await check(request);
    },

    async buy(): Promise<void> {
      const { request, stage } = get();
      if (request === null || stage.kind !== "ready") return;
      // Нехватка видна на кнопке, и нажатие её не шлёт: сервер всё равно откажет.
      if (!gemOffer(stage.offer).affordable) return;
      const { offer } = stage;
      set({ stage: { kind: "buying", offer } });

      const answer = await deps.api.buy(request.runId, request.continueNo, request.elapsedSec);
      if (!current(request)) return;
      if (answer.ok) {
        const { balance } = answer.data;
        useWallet.setState((wallet) => (wallet.balances === null ? wallet : { balances: { ...wallet.balances, gems: balance } }));
        set({ stage: { kind: "idle" }, request: null });
        useRun.getState().continueRun("gems");
        return;
      }
      switch (answer.code) {
        case "insufficient_funds":
          return gone("insufficient_funds");
        case "continue_taken":
          return gone("taken");
        case "continue_unavailable":
          return gone("used_up");
        case "run_unverified":
          return gone("unverified");
      }
      if (answer.failure === "offline" || answer.failure === "unavailable") {
        // Ответ мог потеряться уже после списания: повтор тем же номером вернёт прежний ответ.
        set({ stage: { kind: "ready", offer, notice: "offline" } });
        return;
      }
      gone("not_offered");
    },

    reset(): void {
      set({ stage: { kind: "idle" }, request: null });
    },
  };
});

/** Причина сервера → причина экрана: незнакомая считается «не предлагается». */
function unavailableReason(reason: string): GemUnavailableReason {
  return reason === "unverified" || reason === "finished" || reason === "used_up" ? reason : "not_offered";
}
