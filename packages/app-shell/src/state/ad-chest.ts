import { z } from "zod/mini";
import { create } from "zustand";
import { adsPlayable, trackAdReward, watchAd, type AdWatchResult } from "./ad-watch";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { useRun } from "./run";
import { useRuns } from "./runs";

/**
 * Второй сундук клада за ролик в окне сундука (docs/35-stage4-plan.md Р162, tasks/T-0328): можно ли —
 * спрашиваем сервер, сундук — по досмотренной сессии показа, у VIP — без ролика. Едет в чанке экрана
 * забега. Устроено так же, как переброс карточек за рекламу (`state/ad-reroll.ts`).
 *
 * **Сундук даёт сервер, а не ответ SDK**: движку `openAdChest` уходит после того, как сервер записал
 * показ. Ролик досмотрен, а ответ сервера потерялся — повтор забирает ту же сессию, второй ролик
 * смотреть не нужно. Один раз за забег: и движок, и сервер держат это сами, здесь — только лишняя
 * кнопка не рисуется. Заметок игроку нет: нет рекламы, кап, нет входа, ошибка показа — кнопка
 * просто уходит, а «Забрать» работает как прежде.
 */

const viewSchema = z.union([
  z.object({ status: z.literal("available"), pass: z.nullable(z.string()) }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);
const claimSchema = z.object({ granted: z.boolean() });

export type AdChestView = z.infer<typeof viewSchema>;

export interface AdChestApi {
  view(runId: string): Promise<ApiResult<AdChestView>>;
  claim(runId: string, sessionId: string): Promise<ApiResult<{ granted: boolean }>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createAdChestApi(request: ApiRequest = apiRequest): AdChestApi {
  const path = (runId: string) => `/api/v1/runs/${encodeURIComponent(runId)}/chests/ad`;
  return {
    view: (runId) => request(path(runId), viewSchema, { method: "GET" }),
    claim: (runId, sessionId) => request(path(runId), claimSchema, { method: "POST", body: { sessionId } }),
  };
}

/**
 * Стадия кнопки: `idle` — не спрашивали; `checking` — сервер отвечает, кнопки нет (не мигает); `ready`
 * — кнопка есть, `pass` — без ролика (VIP); `watching` — идёт ролик или забор; `gone` — второго сундука
 * в этом забеге больше не будет.
 */
export type AdChestStage =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ready"; pass: boolean }
  | { kind: "watching"; pass: boolean }
  | { kind: "gone" };

export interface AdChestDeps {
  api: AdChestApi;
  /** ролик за награду места `clad_chest` — или пропуск VIP */
  watch(): Promise<AdWatchResult>;
  /** награда за рекламу выдана — для `ad_reward_claimed` */
  rewarded(source: "ad" | "pass"): void;
  /** показывает ли площадка ролики: без этого кнопки нет вовсе */
  playable(): boolean;
  sleep(ms: number): Promise<void>;
}

/** Пауза перед вторым вопросом: старт забега мог ещё уходить из очереди. */
const UNVERIFIED_RETRY_MS = 1_500;

let deps: AdChestDeps = {
  api: createAdChestApi(),
  watch: async () => await watchAd("clad_chest"),
  rewarded: (source) => trackAdReward("clad_chest", source),
  playable: adsPlayable,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function setAdChestDepsForTests(next: Partial<AdChestDeps>): void {
  deps = { ...deps, ...next };
}

/** Что экран знает об окне: забег и то, что сказал движок. */
export interface AdChestPrepare {
  runId: string;
  /** сундук открыт кладом, и право на второй не потрачено — по движку */
  canAdChest: boolean;
}

export interface AdChestStore {
  stage: AdChestStage;
  /** забег, чей сундук решается: ответы по чужому забегу отбрасываются */
  runId: string | null;
  /** досмотренная, но не забранная сессия — повтор заберёт её без нового ролика */
  watched: { sessionId: string; source: "ad" | "pass" } | null;
  /** Спросить сервер, один раз на забег и только когда кнопка вообще возможна. */
  prepare(input: AdChestPrepare): Promise<void>;
  watch(): Promise<void>;
  reset(): void;
}

const EMPTY = {
  stage: { kind: "idle" } as AdChestStage,
  runId: null as string | null,
  watched: null as AdChestStore["watched"],
};

/**
 * Отказ забора, после которого повторять незачем: у сервера есть код (сундук уже взят, сессия потрачена,
 * показ не принят, ограничение) или он закрыт для игрока. Сбой связи и перегрузка без кода — повтор той же
 * сессией: сервер отдаст тот же ответ, а не отказ.
 */
function isFinalRefusal(answer: { failure: string; code?: string }): boolean {
  if (answer.code === "rate_limited") return false;
  return answer.code !== undefined || answer.failure === "disabled" || answer.failure === "rejected";
}

export const useAdChest = create<AdChestStore>((set, get) => {
  const current = (runId: string): boolean => get().runId === runId;

  function gone(): void {
    set({ stage: { kind: "gone" }, watched: null });
  }

  async function check(runId: string, secondTry = false): Promise<void> {
    // Без старта забега на сервере брать нечего, а старт мог ещё лежать в очереди.
    await useRuns.getState().flush("continue");
    const answer = await deps.api.view(runId);
    if (!current(runId)) return;
    if (answer.ok) {
      if (answer.data.status === "available") set({ stage: { kind: "ready", pass: answer.data.pass !== null } });
      else gone();
      return;
    }
    if (answer.code === "run_unverified" && !secondTry) {
      await deps.sleep(UNVERIFIED_RETRY_MS);
      if (current(runId)) await check(runId, true);
      return;
    }
    // Связи нет — рекламу не предлагаем: ролик без сервера не засчитать.
    gone();
  }

  async function claim(runId: string, pass: boolean, session: { sessionId: string; source: "ad" | "pass" }, secondTry = false): Promise<void> {
    const answer = await deps.api.claim(runId, session.sessionId);
    if (!current(runId)) return;
    if (answer.ok) {
      deps.rewarded(session.source);
      set({ stage: { kind: "gone" }, watched: null });
      useRun.getState().openAdChest();
      return;
    }
    // Сервер ещё не видит старта забега — сессия при этом не потрачена: одна пауза и повтор.
    if (answer.code === "run_unverified" && !secondTry) {
      await deps.sleep(UNVERIFIED_RETRY_MS);
      if (current(runId)) await claim(runId, pass, session, true);
      return;
    }
    if (isFinalRefusal(answer)) return gone();
    // Связь оборвалась после показа: сессия цела, следующее нажатие заберёт её без нового ролика.
    set({ stage: { kind: "ready", pass }, watched: session });
  }

  return {
    ...EMPTY,

    async prepare(input: AdChestPrepare): Promise<void> {
      if (!input.canAdChest || !deps.playable()) return;
      if (get().runId === input.runId) return;
      set({ ...EMPTY, runId: input.runId, stage: { kind: "checking" } });
      await check(input.runId);
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
          // Закрыл сам — не ошибка: можно посмотреть ещё раз.
          set({ stage: { kind: "ready", pass } });
          return;
        case "no_ads":
        case "cooldown":
        case "restricted":
        case "failed":
          return gone();
      }
    },

    reset(): void {
      set({ ...EMPTY });
    },
  };
});

// Забег сменился — «Ещё раз» после смерти, выход, новый забег, — и кнопка прежнего забега ему не
// принадлежит: готовая кнопка не должна пережить рестарт и забрать сессию под чужим идентификатором.
// Подписка, а не эффект экрана: стор сбрасывается в ту же секунду, до следующей отрисовки.
useRun.subscribe((state, previous) => {
  if (state.runId === previous.runId) return;
  const adChest = useAdChest.getState();
  // `prepare` уже закрепил за собой этот забег — не трогаем.
  if (adChest.runId !== state.runId) adChest.reset();
});
