import type { DifficultyId, RunMode } from "@bh/shared-types";
import { useEffect } from "react";
import { create } from "zustand";
import { z } from "zod/mini";
import { sessionReady } from "./first-run";
import { RATED_DIFFICULTY_ID, TUTORIAL_DIFFICULTY_ID } from "./difficulty";
import type { HintId, HintSignals } from "./hints";
import type { HistoryEntry } from "./history-api";
import { useMeta } from "./meta";
import { createPersistedValue } from "./persisted";
import { useRuns } from "./runs";
import { reportError, track, useShell } from "./shell";

/**
 * Пролог в оболочке (tasks/T-0280, docs/35-stage4-plan.md Р151): первый забег
 * аккаунта на три минуты. Здесь — правила без разметки: пролог или обычный
 * забег, открыты ли разделы, что говорит главная, шаги воронки. Экраны только
 * читают готовое.
 *
 * Пролог в профиле решает сервер (`prologueDone`, T-0279); оболочка держит
 * лишь отметку о победе, которая ещё не дошла до сервера, и метки «Новое».
 */

/** Сколько ждать профиль на «Играть»: игрок, нажавший кнопку, ждать не должен (как `playedBefore`). */
const PROFILE_WAIT_MS = 2500;

// --- Правило запуска ---

/**
 * Пролог или обычный забег. Профиль сказал — решено; профиль не пришёл — по
 * числу забегов на устройстве: нет ни одного, значит, пролог.
 */
export function shouldPlayPrologue(input: { prologueDone: boolean | null; runs: number }): boolean {
  if (input.prologueDone !== null) return !input.prologueDone;
  return input.runs === 0;
}

/**
 * Сложность забега по режиму. Пролог — «лёгкая» (так её ставит и движок), всё
 * остальное — единая: правило «забегов нет — лёгкая» (T-0190) заменено, обучающий
 * забег теперь и есть пролог.
 */
export function difficultyForMode(mode: RunMode): DifficultyId {
  return mode === "prologue" ? TUTORIAL_DIFFICULTY_ID : RATED_DIFFICULTY_ID;
}

/**
 * Пролог ли следующий забег. Победа, которая ещё не дошла до сервера, — это
 * уже не пролог. Профиль, загруженный на запуске, не спрашивается второй раз;
 * иначе ждём его недолго — не успели, решает число забегов.
 */
export async function resolvePrologue(options: { timeoutMs?: number } = {}): Promise<boolean> {
  if (usePrologue.getState().wonLocal) return false;
  const known = (): boolean | null => useRuns.getState().profile?.prologueDone ?? null;
  if (known() === null) {
    const deadline = Date.now() + (options.timeoutMs ?? PROFILE_WAIT_MS);
    if (await sessionReady(deadline)) {
      const left = deadline - Date.now();
      if (left > 0) {
        await Promise.race([useRuns.getState().loadProfile(), new Promise<void>((resolve) => setTimeout(resolve, left))]);
      }
    }
  }
  return shouldPlayPrologue({ prologueDone: known(), runs: useMeta.getState().runs });
}

// --- Разделы и главная ---

/**
 * Открыты ли «Награда дня» и «Задания». Закрыты до победы в прологе; у старого
 * аккаунта сервер отдаёт «пройден», и без профиля он узнаётся по забегам.
 */
export function sectionsOpenFor(input: { prologueDone: boolean | null; runs: number; wonLocal: boolean }): boolean {
  if (input.wonLocal) return true;
  return !shouldPlayPrologue({ prologueDone: input.prologueDone, runs: input.runs });
}

export type HomeSection = "daily" | "tasks";

/** Что подсвечено «Новым» и висит ли подпись у «Играть»: заводит победа, гасит открытие. */
export interface FreshMarks {
  daily: boolean;
  tasks: boolean;
  play: boolean;
}

export interface HomeFace {
  /** карусель, виджеты и всё остальное, кроме «Играть» */
  sections: boolean;
  /** строка под кнопкой «Играть»: до пролога и после победы; `null` — нет строки */
  line: "first" | "endless" | null;
  /** метка «Новое» у виджетов */
  marks: Record<HomeSection, boolean>;
}

export function homeFace(input: { open: boolean; fresh: FreshMarks }): HomeFace {
  if (!input.open) return { sections: false, line: "first", marks: { daily: false, tasks: false } };
  return {
    sections: true,
    line: input.fresh.play ? "endless" : null,
    marks: { daily: input.fresh.daily, tasks: input.fresh.tasks },
  };
}

/** Раздел открыт впервые — его метка гаснет. */
export function acknowledged(fresh: FreshMarks, section: HomeSection): FreshMarks {
  return { ...fresh, [section]: false };
}

/**
 * Открыты ли разделы сейчас — для главной и нижней панели. Заодно сверяет
 * отметку о победе с профилем: профиль, пришедший после победы, снимает её или
 * подтверждает (`reconcile`). Зависит от самого профиля, а не от очереди: старый
 * профиль после принятого итога не должен снять отметку раньше нового.
 */
export function usePrologueOpen(): boolean {
  const profile = useRuns((state) => state.profile);
  const prologueDone = profile?.prologueDone ?? null;
  const runs = useMeta((state) => state.runs);
  const wonLocal = usePrologue((state) => state.wonLocal);
  useEffect(() => {
    usePrologue.getState().reconcile({ prologueDone, pending: useRuns.getState().pending });
  }, [profile, prologueDone]);
  return sectionsOpenFor({ prologueDone, runs, wonLocal });
}

// --- Шаги воронки ---

export const TUTORIAL_STEPS = ["start", "first_gem", "first_level", "first_elite", "first_chest", "guard", "won"] as const;
export type TutorialStep = (typeof TUTORIAL_STEPS)[number];

/** Сигналы подсказок из пройденных шагов: кристалл, выбор и элита — это шаги воронки. */
export function hintSignalsOf(steps: readonly TutorialStep[]): HintSignals {
  return { gem: steps.includes("first_gem"), levelUp: steps.includes("first_level"), elite: steps.includes("first_elite") };
}

// --- Награда ---

/** Награда в окне победы: считается и выдаётся сервером, оболочка её только показывает. */
export type PrologueReward =
  | { status: "pending" }
  | { status: "granted"; coins: number; gems: number }
  | { status: "none" }
  | { status: "offline" };

/**
 * Награда пролога из истории кошелька: строки с причиной `prologue_reward`.
 * Сервер записывает монеты и самоцветы отдельными строками, и числа берутся
 * из них — панель вправе их менять, константа в клиенте разошлась бы.
 */
export function prologueRewardOf(entries: readonly HistoryEntry[]): { coins: number; gems: number } | null {
  let found = false;
  let coins = 0;
  let gems = 0;
  for (const entry of entries) {
    if (entry.kind !== "wallet" || entry.reason !== "prologue_reward") continue;
    found = true;
    if (entry.resource === "coins") coins += entry.amount;
    else if (entry.resource === "gems") gems += entry.amount;
  }
  return found ? { coins, gems } : null;
}

/** Сколько ждать, пока сервер примет итог пролога, прежде чем сказать «придёт, когда вернётся связь». */
const ACCEPT_WAIT_MS = 8000;
/** Сколько раз и как часто спрашивать историю: итог принят, а строка начисления лежит рядом, но не мгновенно. */
const HISTORY_RETRY_MS = [0, 800, 2000] as const;

/**
 * Что получил игрок за победу: ждёт, пока итог принят сервером, читает
 * начисление из истории кошелька, обновляет профиль и кошелёк — разделы
 * открываются. Нет сети или итог не дошёл — `offline`: награда придёт сама.
 */
export async function settlePrologueWin(runId: string, options: { acceptWaitMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<PrologueReward> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (useShell.getState().capabilities.auth === undefined) return { status: "none" };
  if (!(await waitAccepted(runId, options.acceptWaitMs ?? ACCEPT_WAIT_MS))) return { status: "offline" };

  const [{ createHistoryApi }, { loadWallet }] = await Promise.all([import("./history-api"), import("./wallet-api")]);
  void loadWallet();
  // Профиль — после приёма итога: сервер уже поставил признак, разделы открываются.
  void useRuns
    .getState()
    .loadProfile()
    .then(() => usePrologue.getState().reconcile({ prologueDone: useRuns.getState().profile?.prologueDone ?? null, pending: useRuns.getState().pending }));

  const api = createHistoryApi();
  for (const delay of HISTORY_RETRY_MS) {
    await sleep(delay);
    const page = await api.page("currency", null);
    if (!page.ok) continue;
    const reward = prologueRewardOf(page.data.entries);
    if (reward !== null) return { status: "granted", ...reward };
  }
  // Итог принят, а начисления нет: награда выключена в панели или забег не прошёл проверку.
  return { status: "none" };
}

function waitAccepted(runId: string, timeoutMs: number): Promise<boolean> {
  if (useRuns.getState().lastSubmitted?.runId === runId) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, timeoutMs);
    const unsubscribe = useRuns.subscribe((state) => {
      if (state.lastSubmitted?.runId !== runId) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
  });
}

// --- Состояние ---

const PROLOGUE_KEY = "bh.prologue.v1";

const storedSchema = z.object({
  wonLocal: z.boolean(),
  fresh: z.object({ daily: z.boolean(), tasks: z.boolean(), play: z.boolean() }),
});

const NO_MARKS: FreshMarks = { daily: false, tasks: false, play: false };

/** Оберег: подсказка про него — один раз за пролог. */
export type WardHint = "idle" | "showing" | "done";

/** Состояние текущего забега-пролога; сбрасывается на каждом старте. */
export interface PrologueRun {
  /** подсказки, показанные в этом забеге: виденное на устройстве в прологе не в счёт */
  hintsDone: HintId[];
  steps: TutorialStep[];
  ward: WardHint;
  /** секунда забега, на которой подсказка про оберег появилась */
  wardSinceSec: number;
}

const EMPTY_RUN: PrologueRun = { hintsDone: [], steps: [], ward: "idle", wardSinceSec: 0 };

export interface PrologueStore {
  /** победа есть, а профиль ещё не подтвердил её: разделы открыты, повторного пролога нет */
  wonLocal: boolean;
  fresh: FreshMarks;
  run: PrologueRun;
  hydrate(): void;
  /** Страж пал: разделы открыты, метки «Новое» заведены */
  markWon(): void;
  /** раздел открыт — его «Новое» гаснет */
  acknowledge(section: HomeSection): void;
  /** начался обычный забег: подпись у «Играть» сделала своё */
  endlessRunStarted(): void;
  /** профиль загружен: подтвердил победу — отметка не нужна; отверг при пустой очереди — отметка снимается */
  reconcile(input: { prologueDone: boolean | null; pending: number }): void;
  /** начался забег-пролог */
  beginRun(): void;
  /** шаг воронки: один раз за забег, событие уходит в аналитику */
  step(step: TutorialStep, sec: number): void;
  hintDone(id: HintId): void;
  wardNoticed(sec: number): void;
  wardDone(): void;
}

export const usePrologue = create<PrologueStore>((set, get) => ({
  wonLocal: false,
  fresh: NO_MARKS,
  run: EMPTY_RUN,

  hydrate(): void {
    const stored = value().read();
    set({ wonLocal: stored.wonLocal, fresh: stored.fresh });
  },

  markWon(): void {
    set({ wonLocal: true, fresh: { daily: true, tasks: true, play: true } });
    persist(get());
  },

  acknowledge(section): void {
    if (!get().fresh[section]) return;
    set({ fresh: acknowledged(get().fresh, section) });
    persist(get());
  },

  endlessRunStarted(): void {
    if (!get().fresh.play) return;
    set({ fresh: { ...get().fresh, play: false } });
    persist(get());
  },

  reconcile(input): void {
    if (!get().wonLocal) return;
    if (input.prologueDone === true || (input.prologueDone === false && input.pending === 0)) {
      set({ wonLocal: false });
      persist(get());
    }
  },

  beginRun(): void {
    set({ run: EMPTY_RUN });
  },

  step(step, sec): void {
    const { run } = get();
    if (run.steps.includes(step)) return;
    set({ run: { ...run, steps: [...run.steps, step] } });
    track("tutorial_step", { step });
    if (step === "won") track("tutorial_completed", { sec: Math.round(sec) });
  },

  hintDone(id): void {
    const { run } = get();
    if (run.hintsDone.includes(id)) return;
    set({ run: { ...run, hintsDone: [...run.hintsDone, id] } });
  },

  wardNoticed(sec): void {
    const { run } = get();
    if (run.ward !== "idle") return;
    set({ run: { ...run, ward: "showing", wardSinceSec: sec } });
  },

  wardDone(): void {
    const { run } = get();
    if (run.ward === "done") return;
    set({ run: { ...run, ward: "done" } });
  },
}));

function persist(state: PrologueStore): void {
  value().write({ wonLocal: state.wonLocal, fresh: state.fresh });
}

function value(): ReturnType<typeof createPersistedValue<z.infer<typeof storedSchema>>> {
  return createPersistedValue<z.infer<typeof storedSchema>>({
    storage: useShell.getState().storage,
    key: PROLOGUE_KEY,
    schema: storedSchema,
    fallback: { wonLocal: false, fresh: NO_MARKS },
    onBroken: (key, reason) => reportError("prologue", `${key}: ${reason}`),
  });
}
