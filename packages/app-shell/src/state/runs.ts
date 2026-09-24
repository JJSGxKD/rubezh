import {
  DIFFICULTY_IDS,
  type DifficultyId,
  type Leaderboard,
  type RunFinishResult,
  type RunFinishSubmission,
  type RunProfile,
  type RunResult,
  type RunStartSubmission,
} from "@bh/shared-types";
import { create } from "zustand";
import { z } from "zod/mini";
import type { ApiFailure } from "./api-request";
import { useMeta } from "./meta";
import { createPersistedValue } from "./persisted";
import { createRunsApi, type RunsApi } from "./runs-api";
import { reportError, track, useShell } from "./shell";

/**
 * Забеги под аккаунтом на сервере и рейтинг (docs/34-stage3-plan.md, WP4).
 *
 * **Одна очередь на старт и итог.** Сначала в неё ложится старт — в момент
 * начала забега, — потом итог. Серверу важен порядок: по старту он ставит
 * своё время начала и сверяет с ним длительность итога. Игрок, умерший в
 * метро, не теряет забег — всё уйдёт при следующем запуске, по порядку.
 * Повтор безопасен: сервер узнаёт забег по `runId` и не считает его дважды.
 *
 * Сборка без авторизации (MAX, VK, тесты) не отправляет ничего, а рекорд на
 * устройстве ведётся как раньше (state/meta.ts).
 */
const QUEUE_KEY = "bh.runs.v1.pending";
/**
 * Очередь до переезда на аккаунты — одни итоги, без старта. Забеги из неё
 * переносятся в новую при первом запуске: выбрасывать их незачем, сервер
 * примет итог и без старта, только время не проверит.
 */
const LEGACY_QUEUE_KEY = "bh.playtest.v1.pending";

/**
 * Сколько записей хранить: двадцать забегов со стартом и итогом. Больше
 * копится, только если сервер недоступен неделями, — тогда старые уже никому
 * не интересны. Выпавший старт не страшен: итог без него принимается.
 */
const QUEUE_LIMIT = 40;

/** Потолок сервера: старт, пролежавший дольше суток, не принимается схемой. */
const MAX_ELAPSED_SEC = 86_400;

const finishFields = {
  runId: z.string(),
  difficultyId: z.enum(DIFFICULTY_IDS),
  outcome: z.enum(["died", "abandoned"]),
  survivalSec: z.number(),
  level: z.number(),
  enemiesKilled: z.number(),
  startingWeaponId: z.string(),
  weapons: z.array(z.object({ id: z.string(), level: z.number() })),
  contentHash: z.string(),
  // Необязательные: забеги в очереди от прошлой сборки этих полей не знают,
  // и выбрасывать их из-за этого незачем.
  deathCause: z.optional(z.nullable(z.string())),
  cheats: z.optional(z.boolean()),
  countInRating: z.optional(z.boolean()),
  continues: z.optional(z.array(z.number())),
};

const startEntrySchema = z.object({
  kind: z.literal("start"),
  runId: z.string(),
  difficultyId: z.enum(DIFFICULTY_IDS),
  startingWeaponId: z.string(),
  contentHash: z.string(),
  /** когда забег начался по часам устройства: к отправке прибавится ожидание */
  startedAtMs: z.number(),
});

const finishEntrySchema = z.object({ kind: z.literal("finish"), ...finishFields });

const queueSchema = z.array(z.union([startEntrySchema, finishEntrySchema]));
const legacyQueueSchema = z.array(z.object(finishFields));

type QueueEntry = z.infer<typeof startEntrySchema> | z.infer<typeof finishEntrySchema>;

/**
 * Что запустило отправку — разрез события: начало или конец забега, запуск
 * приложения, открытие рейтинга и профиля, вопрос о цене второго шанса.
 */
type FlushTrigger = "start" | "finish" | "launch" | "screen" | "continue";

export interface RunsStore {
  /** сколько итогов ждёт отправки; старты игроку не показываются */
  pending: number;
  /** ответ сервера на последний отправленный итог — место на экране смерти */
  lastSubmitted: { runId: string; result: RunFinishResult } | null;
  /** последний полученный лидерборд каждой сложности: вкладка открывается без мигания */
  leaderboards: Partial<Record<DifficultyId, Leaderboard>>;
  profile: RunProfile | null;

  hydrate(): void;
  /** поставить старт забега в очередь и попробовать отправить */
  registerStart(start: { runId: string; difficultyId: DifficultyId; startingWeaponId: string }): void;
  /** поставить итог забега в очередь и попробовать отправить */
  submitRun(result: RunResult, countInRating?: boolean): void;
  flush(trigger: FlushTrigger): Promise<void>;
  /** обновить лидерборд; `null` — удалось, иначе причина неудачи */
  loadLeaderboard(difficultyId: DifficultyId): Promise<ApiFailure | null>;
  loadProfile(): Promise<ApiFailure | null>;
}

/** Идёт ли отправка: две параллельные отправили бы один забег дважды. */
let flushing = false;

export const useRuns = create<RunsStore>((set, get) => ({
  pending: 0,
  lastSubmitted: null,
  leaderboards: {},
  profile: null,

  hydrate(): void {
    if (api() === null) {
      set({ pending: 0 });
      return;
    }
    migrateLegacyQueue();
    set({ pending: pendingOf(queue().read()) });
  },

  registerStart(start): void {
    if (api() === null) return;
    enqueue({ kind: "start", ...start, contentHash: useShell.getState().build.contentHash, startedAtMs: Date.now() });
    set({ pending: pendingOf(queue().read()) });
    void get().flush("start");
  },

  submitRun(result, countInRating = false): void {
    if (api() === null) return;
    enqueue({ kind: "finish", ...toSubmission(result, countInRating) });
    set({ pending: pendingOf(queue().read()) });
    void get().flush("finish");
  },

  async flush(trigger): Promise<void> {
    const client = api();
    if (client === null || flushing) return;
    flushing = true;

    try {
      // По одному и по порядку: у сервера нет пакетной записи, старт обязан
      // прийти раньше итога, а «последние забеги» в профиле остаются такими,
      // какими были.
      for (;;) {
        const head = queue().read()[0];
        if (head === undefined) break;

        const response = head.kind === "start" ? await client.start(toStart(head, Date.now())) : await client.finish(toFinish(head));
        if (!response.ok && response.failure !== "rejected") {
          // Сеть, сервер, сессия — всё это проходит само: запись ждёт
          // следующей попытки, а остальные за ней — тем более.
          track("run_synced", { kind: head.kind, result: "queued", failure: response.failure, trigger });
          break;
        }

        removeFromQueue(head);
        set({ pending: pendingOf(queue().read()) });
        if (!response.ok) {
          // Сервер отверг сами данные — повтор этой записи не поможет, а
          // застрявшая в голове очереди она не пускала бы остальные.
          reportError("runs", `${head.kind === "start" ? "старт" : "итог"} забега ${head.runId} отвергнут сервером`);
          track("run_synced", { kind: head.kind, result: "dropped", failure: response.failure, trigger });
          continue;
        }

        if ("trusted" in response.data) {
          track("run_synced", { kind: "start", result: "sent", trigger, trusted: response.data.trusted });
          continue;
        }
        const result = response.data;
        set({ lastSubmitted: { runId: head.runId, result } });
        useMeta.getState().mergeRemote({ best: { [head.difficultyId]: result.bestSurvivalSec } });
        track("run_synced", {
          kind: "finish",
          result: "sent",
          trigger,
          rank: result.rank,
          isNewBest: result.isNewBest,
          recorded: result.recorded,
          verdict: result.verdict,
        });
      }
    } finally {
      flushing = false;
    }
  },

  async loadLeaderboard(difficultyId): Promise<ApiFailure | null> {
    const client = api();
    if (client === null) return "disabled";
    const response = await client.leaderboard(difficultyId);
    if (!response.ok) return response.failure;
    set({ leaderboards: { ...get().leaderboards, [difficultyId]: response.data } });
    return null;
  },

  async loadProfile(): Promise<ApiFailure | null> {
    const client = api();
    if (client === null) return "disabled";
    const response = await client.profile();
    if (!response.ok) return response.failure;
    set({ profile: response.data });
    const best: Partial<Record<DifficultyId, number>> = {};
    for (const id of DIFFICULTY_IDS) {
      const entry = response.data.best[id];
      if (entry !== null) best[id] = entry.survivalSec;
    }
    useMeta.getState().mergeRemote({ runs: response.data.runs, best });
    return null;
  },
}));

/**
 * Только поля, которые нужны рейтингу, профилю и антифроду: урон и убийства
 * по врагам серверу ни к чему. `countInRating` — просьба администратора учесть
 * забег с читами; сервер выполнит её, только если у аккаунта есть право.
 */
export function toSubmission(result: RunResult, countInRating = false): RunFinishSubmission {
  return {
    ...(result.cheats ? { cheats: true, countInRating } : {}),
    runId: result.runId,
    difficultyId: result.difficultyId,
    outcome: result.outcome,
    survivalSec: result.survivalSec,
    level: result.level,
    enemiesKilled: result.enemiesKilled,
    startingWeaponId: result.startingWeaponId,
    weapons: result.weapons.map(({ id, level }) => ({ id, level })),
    contentHash: result.contentHash,
    deathCause: result.deathCause,
    // Без секунд продолжений сервер счёл бы купленный второй шанс
    // неоплаченным — и наоборот, не нашёл бы, что сверять с покупкой.
    continues: [...result.continues],
  };
}

/**
 * Сколько секунд забега прошло к отправке старта. Сервер вычитает это из
 * своего времени приёма: старт, пролежавший в очереди без сети, не должен
 * сдвинуть начало забега на момент, когда появилась связь.
 */
export function toStart(entry: z.infer<typeof startEntrySchema>, nowMs: number): RunStartSubmission {
  const elapsedSec = Math.min(MAX_ELAPSED_SEC, Math.max(0, (nowMs - entry.startedAtMs) / 1000));
  return {
    runId: entry.runId,
    difficultyId: entry.difficultyId,
    startingWeaponId: entry.startingWeaponId,
    contentHash: entry.contentHash,
    elapsedSec: Math.round(elapsedSec * 10) / 10,
  };
}

/** Запись очереди без её вида — ровно то тело, что ждёт сервер. */
function toFinish({ kind: _kind, ...submission }: z.infer<typeof finishEntrySchema>): RunFinishSubmission {
  return submission;
}

function pendingOf(entries: readonly QueueEntry[]): number {
  return entries.filter((entry) => entry.kind === "finish").length;
}

function api(): RunsApi | null {
  return useShell.getState().capabilities.auth === undefined ? null : createRunsApi();
}

function enqueue(entry: QueueEntry): void {
  queue().write([...queue().read(), entry].slice(-QUEUE_LIMIT));
}

function removeFromQueue(entry: QueueEntry): void {
  queue().write(queue().read().filter((item) => item.kind !== entry.kind || item.runId !== entry.runId));
}

/**
 * Итоги из очереди прошлой сборки — в голову новой: они старше всего, что
 * успело лечь в новую. Старый ключ снимается сразу — второй раз не перенесётся.
 */
function migrateLegacyQueue(): void {
  const storage = useShell.getState().storage;
  const legacy = createPersistedValue({
    storage,
    key: LEGACY_QUEUE_KEY,
    schema: legacyQueueSchema,
    fallback: [],
    onBroken: (key, reason) => reportError("runs", `${key}: ${reason}`),
  }).read();
  if (legacy.length === 0) return;
  const moved: QueueEntry[] = legacy.map((submission) => ({ kind: "finish", ...submission }));
  queue().write([...moved, ...queue().read()].slice(-QUEUE_LIMIT));
  storage?.remove(LEGACY_QUEUE_KEY);
}

function queue(): ReturnType<typeof createPersistedValue<QueueEntry[]>> {
  return createPersistedValue<QueueEntry[]>({
    storage: useShell.getState().storage,
    key: QUEUE_KEY,
    schema: queueSchema,
    fallback: [],
    onBroken: (key, reason) => reportError("runs", `${key}: ${reason}`),
  });
}
