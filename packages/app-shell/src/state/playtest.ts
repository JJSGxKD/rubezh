import {
  DIFFICULTY_IDS,
  type DifficultyId,
  type PlaytestLeaderboard,
  type PlaytestProfile,
  type PlaytestRunSubmission,
  type PlaytestSubmitResult,
  type RunResult,
} from "@bh/shared-types";
import { create } from "zustand";
import { z } from "zod/mini";
import { createPersistedValue } from "./persisted";
import { createPlaytestApi, type PlaytestApi, type PlaytestFailure } from "./playtest-api";
import { reportError, track, useShell } from "./shell";

/**
 * Итоги забегов на сервере плейтеста и лидерборд (docs/26-stage2-plan.md, WP13).
 *
 * Итог сначала ложится в очередь на устройстве и только потом уходит на
 * сервер: игрок, умерший в метро, не теряет забег — он уйдёт при следующем
 * запуске. Повтор безопасен: сервер узнаёт забег по `runId` и не считает его
 * дважды.
 *
 * Сборка без бэкенда плейтеста (MAX, VK, тесты) не отправляет ничего, а
 * рекорд на устройстве ведётся как раньше (state/meta.ts).
 */
const QUEUE_KEY = "bh.playtest.v1.pending";

/**
 * Сколько неотправленных забегов хранить. Больше двадцати копится, только
 * если сервер недоступен неделями, — тогда старые уже никому не интересны.
 */
const QUEUE_LIMIT = 20;

const submissionSchema = z.object({
  runId: z.string(),
  difficultyId: z.enum(DIFFICULTY_IDS),
  outcome: z.enum(["died", "abandoned"]),
  survivalSec: z.number(),
  level: z.number(),
  enemiesKilled: z.number(),
  startingWeaponId: z.string(),
  weapons: z.array(z.object({ id: z.string(), level: z.number() })),
  contentHash: z.string(),
});

const queueSchema = z.array(submissionSchema);

/**
 * Что запустило отправку — разрез события: сразу после забега, при запуске
 * приложения или при открытии рейтинга и профиля.
 */
type FlushTrigger = "finish" | "launch" | "screen";

export interface PlaytestStore {
  /** сколько забегов ждёт отправки */
  pending: number;
  /** ответ сервера на последний отправленный забег — место на экране смерти */
  lastSubmitted: { runId: string; result: PlaytestSubmitResult } | null;
  /** последний полученный лидерборд каждой сложности: вкладка открывается без мигания */
  leaderboards: Partial<Record<DifficultyId, PlaytestLeaderboard>>;
  profile: PlaytestProfile | null;

  hydrate(): void;
  /** поставить итог забега в очередь и попробовать отправить */
  submitRun(result: RunResult): void;
  flush(trigger: FlushTrigger): Promise<void>;
  /** обновить лидерборд; `null` — удалось, иначе причина неудачи */
  loadLeaderboard(difficultyId: DifficultyId): Promise<PlaytestFailure | null>;
  loadProfile(): Promise<PlaytestFailure | null>;
}

/** Идёт ли отправка: две параллельные отправили бы один забег дважды. */
let flushing = false;

export const usePlaytest = create<PlaytestStore>((set, get) => ({
  pending: 0,
  lastSubmitted: null,
  leaderboards: {},
  profile: null,

  hydrate(): void {
    set({ pending: api() === null ? 0 : queue().read().length });
  },

  submitRun(result): void {
    if (api() === null) return;
    const next = [...queue().read(), toSubmission(result)].slice(-QUEUE_LIMIT);
    queue().write(next);
    set({ pending: next.length });
    void get().flush("finish");
  },

  async flush(trigger): Promise<void> {
    const client = api();
    if (client === null || flushing) return;
    flushing = true;

    try {
      // По одному и по порядку: у сервера нет пакетной записи, а порядок
      // сохраняет «последние забеги» в профиле такими, какими они были.
      for (;;) {
        const head = queue().read()[0];
        if (head === undefined) break;

        const response = await client.submitRun(head);
        if (!response.ok && response.failure !== "rejected") {
          // Сеть, сервер, подпись — всё это проходит само: забег ждёт
          // следующей попытки, а остальные за ним — тем более.
          track("playtest_run_synced", { result: "queued", failure: response.failure, trigger });
          break;
        }

        removeFromQueue(head.runId);
        set({ pending: queue().read().length });
        if (response.ok) {
          set({ lastSubmitted: { runId: head.runId, result: response.data } });
          track("playtest_run_synced", {
            result: "sent",
            trigger,
            rank: response.data.rank,
            isNewBest: response.data.isNewBest,
          });
        } else {
          // Сервер отверг сами данные — повтор этого забега не поможет, а
          // застрявший в голове очереди он не пускал бы остальных.
          reportError("playtest", `итог забега ${head.runId} отвергнут сервером`);
          track("playtest_run_synced", { result: "dropped", failure: response.failure, trigger });
        }
      }
    } finally {
      flushing = false;
    }
  },

  async loadLeaderboard(difficultyId): Promise<PlaytestFailure | null> {
    const client = api();
    if (client === null) return "disabled";
    const response = await client.leaderboard(difficultyId);
    if (!response.ok) return response.failure;
    set({ leaderboards: { ...get().leaderboards, [difficultyId]: response.data } });
    return null;
  },

  async loadProfile(): Promise<PlaytestFailure | null> {
    const client = api();
    if (client === null) return "disabled";
    const response = await client.profile();
    if (!response.ok) return response.failure;
    set({ profile: response.data });
    return null;
  },
}));

/** Только поля, которые нужны лидерборду и профилю: урон и убийства по врагам серверу ни к чему. */
export function toSubmission(result: RunResult): PlaytestRunSubmission {
  return {
    runId: result.runId,
    difficultyId: result.difficultyId,
    outcome: result.outcome,
    survivalSec: result.survivalSec,
    level: result.level,
    enemiesKilled: result.enemiesKilled,
    startingWeaponId: result.startingWeaponId,
    weapons: result.weapons.map(({ id, level }) => ({ id, level })),
    contentHash: result.contentHash,
  };
}

function api(): PlaytestApi | null {
  const { capabilities, adapter } = useShell.getState();
  if (capabilities.playtest === undefined) return null;
  return createPlaytestApi(capabilities.playtest, () => adapter.signedLaunchData());
}

function removeFromQueue(runId: string): void {
  queue().write(queue().read().filter((entry) => entry.runId !== runId));
}

function queue(): ReturnType<typeof createPersistedValue<PlaytestRunSubmission[]>> {
  return createPersistedValue<PlaytestRunSubmission[]>({
    storage: useShell.getState().storage,
    key: QUEUE_KEY,
    schema: queueSchema,
    fallback: [],
    onBroken: (key, reason) => reportError("playtest", `${key}: ${reason}`),
  });
}
