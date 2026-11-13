import { z } from "zod/mini";
import { create } from "zustand";
import { adsPlayable, trackAdReward, watchAd, type AdWatchResult } from "./ad-watch";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { useRun } from "./run";
import { useRuns } from "./runs";
import { track } from "./shell";

/**
 * Переброс карточек за рекламу на выборе улучшения (docs/35-stage4-plan.md
 * Р133, tasks/T-0199): можно ли — спрашиваем сервер, переброс — по
 * досмотренной сессии показа, у VIP — без ролика. Едет в чанке экрана забега.
 *
 * **Переброс даёт сервер, а не ответ SDK**, как у второго шанса: движку
 * `rerollOffersViaAd` уходит после того, как сервер записал показ. Ролик
 * досмотрен, а ответ сервера потерялся — повтор забирает ту же сессию, и
 * второй ролик смотреть не нужно. Один раз за забег: и движок, и сервер
 * держат это сами, здесь — только лишняя кнопка не рисуется.
 */

const viewSchema = z.union([
  z.object({ status: z.literal("available"), pass: z.nullable(z.string()) }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);
const claimSchema = z.object({ granted: z.boolean() });

export type AdRerollView = z.infer<typeof viewSchema>;

export interface AdRerollApi {
  view(runId: string): Promise<ApiResult<AdRerollView>>;
  claim(runId: string, sessionId: string): Promise<ApiResult<{ granted: boolean }>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createAdRerollApi(request: ApiRequest = apiRequest): AdRerollApi {
  const path = (runId: string) => `/api/v1/runs/${encodeURIComponent(runId)}/rerolls/ad`;
  return {
    view: (runId) => request(path(runId), viewSchema, { method: "GET" }),
    claim: (runId, sessionId) => request(path(runId), claimSchema, { method: "POST", body: { sessionId } }),
  };
}

/**
 * Что сказать под кнопкой, когда переброса не вышло: `closed` — ролик закрыт
 * раньше конца; `failed` — реклама не загрузилась; `claim_failed` — ролик
 * досмотрен, сервер не ответил: повтор без нового ролика; `restricted` —
 * награды за рекламу закрыты ограничением (WP44), подробности в профиле.
 */
export type AdRerollNotice = "closed" | "failed" | "claim_failed" | "restricted";

/**
 * Стадия кнопки: `idle` — не спрашивали; `checking` — сервер отвечает, кнопки
 * нет (не мигает); `ready` — кнопка есть, `pass` — без ролика (VIP); `watching`
 * — идёт ролик; `gone` — переброса за рекламу в этом забеге больше не будет.
 */
export type AdRerollStage =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ready"; pass: boolean }
  | { kind: "watching"; pass: boolean }
  | { kind: "gone" };

export interface AdRerollDeps {
  api: AdRerollApi;
  /** ролик за награду места `card_reroll` — или пропуск VIP */
  watch(): Promise<AdWatchResult>;
  /** награда за рекламу выдана — для `ad_reward_claimed` */
  rewarded(source: "ad" | "pass"): void;
  /** показывает ли площадка ролики: без этого кнопка «за рекламу» есть только у VIP, а у нас её нет вовсе */
  playable(): boolean;
  sleep(ms: number): Promise<void>;
}

/** Пауза перед вторым вопросом: старт забега мог ещё уходить из очереди. */
const UNVERIFIED_RETRY_MS = 1_500;

/** Отказы сервера на забор, после которых кнопки больше нет: переброс взят, сессия потрачена или забег закрыт. */
const GONE = new Set(["reroll_unavailable", "reroll_taken"]);

let deps: AdRerollDeps = {
  api: createAdRerollApi(),
  watch: async () => await watchAd("card_reroll"),
  rewarded: (source) => trackAdReward("card_reroll", source),
  playable: adsPlayable,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function setAdRerollDepsForTests(next: Partial<AdRerollDeps>): void {
  deps = { ...deps, ...next };
}

/** Что экран знает о выборе: забег, сколько зарядов переброса осталось и что сказал движок. */
export interface AdRerollPrepare {
  runId: string;
  /** зарядов переброса осталось: пока они есть, за рекламу не предлагаем */
  reroll: number;
  /** сработает ли переброс за рекламу — по движку */
  canAdReroll: boolean;
}

export interface AdRerollStore {
  stage: AdRerollStage;
  notice: AdRerollNotice | null;
  /** номер выбора, на котором появилась заметка: на следующем выборе она устарела */
  noticeSeq: number | null;
  /** забег, чей переброс решается: ответы по чужому забегу отбрасываются */
  runId: string | null;
  /** досмотренная, но не забранная сессия — повтор заберёт её без нового ролика */
  watched: { sessionId: string; source: "ad" | "pass" } | null;
  /** на каком выборе кнопка уже показана игроку — `card_reroll_ad_offered` раз на выбор */
  offeredSeq: number | null;
  /** Спросить сервер, один раз на забег и только когда кнопка вообще возможна. */
  prepare(input: AdRerollPrepare): Promise<void>;
  watch(): Promise<void>;
  /** Кнопка показана на выборе `seq` — событие аналитики; повтор того же выбора ничего не шлёт. */
  reportOffered(input: { seq: number; level: number }): void;
  reset(): void;
}

const EMPTY = {
  stage: { kind: "idle" } as AdRerollStage,
  notice: null as AdRerollNotice | null,
  noticeSeq: null as number | null,
  runId: null as string | null,
  watched: null as AdRerollStore["watched"],
  offeredSeq: null as number | null,
};

export const useAdReroll = create<AdRerollStore>((set, get) => {
  const current = (runId: string): boolean => get().runId === runId;

  /** Заметка привязана к выбору, на котором случилась. */
  function notify(notice: AdRerollNotice): void {
    set({ notice, noticeSeq: useRun.getState().offerSeq });
  }

  function gone(): void {
    set({ stage: { kind: "gone" }, watched: null });
  }

  async function check(runId: string, secondTry = false): Promise<void> {
    // Без старта забега на сервере перебрасывать нечем, а старт мог ещё лежать в очереди.
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
      set({ stage: { kind: "gone" }, notice: null, noticeSeq: null, watched: null });
      useRun.getState().rerollViaAd();
      return;
    }
    // Сервер ещё не видит старта забега — сессия при этом не потрачена: одна пауза и повтор.
    if (answer.code === "run_unverified" && !secondTry) {
      await deps.sleep(UNVERIFIED_RETRY_MS);
      if (current(runId)) await claim(runId, pass, session, true);
      return;
    }
    // Ограничение наложили между выдачей и забором. Код строкой, как у соседних отказов:
    // модуль ограничений экрану забега не нужен.
    if (answer.code === "account_restricted") {
      gone();
      notify("restricted");
      return;
    }
    if (answer.code === "run_unverified" || GONE.has(answer.code ?? "")) return gone();
    if (answer.code === "ad_not_completed") {
      set({ stage: { kind: "ready", pass }, watched: null });
      notify("failed");
      return;
    }
    set({ stage: { kind: "ready", pass }, watched: session });
    notify("claim_failed");
  }

  return {
    ...EMPTY,

    async prepare(input: AdRerollPrepare): Promise<void> {
      if (input.reroll > 0 || !input.canAdReroll || !deps.playable()) return;
      if (get().runId === input.runId) return;
      set({ ...EMPTY, runId: input.runId, stage: { kind: "checking" } });
      await check(input.runId);
    },

    async watch(): Promise<void> {
      const { runId, stage, watched } = get();
      if (runId === null || stage.kind !== "ready") return;
      const pass = stage.pass;
      set({ stage: { kind: "watching", pass }, notice: null, noticeSeq: null });
      if (watched !== null) return await claim(runId, pass, watched);

      const outcome = await deps.watch();
      if (!current(runId)) return;
      switch (outcome.kind) {
        case "watched":
          return await claim(runId, pass, { sessionId: outcome.sessionId, source: outcome.source });
        case "closed":
          set({ stage: { kind: "ready", pass } });
          notify("closed");
          return;
        case "no_ads":
        case "cooldown":
          return gone();
        case "restricted":
          gone();
          notify("restricted");
          return;
        case "failed":
          set({ stage: { kind: "ready", pass } });
          notify("failed");
          return;
      }
    },

    reportOffered({ seq, level }): void {
      const { stage, offeredSeq } = get();
      if (stage.kind !== "ready" || offeredSeq === seq) return;
      set({ offeredSeq: seq });
      track("card_reroll_ad_offered", { level, pass: stage.pass });
    },

    reset(): void {
      set({ ...EMPTY });
    },
  };
});
