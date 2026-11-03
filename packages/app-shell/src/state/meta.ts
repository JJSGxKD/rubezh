import { DIFFICULTY_IDS, type DifficultyId, type RunResult } from "@bh/shared-types";
import { loadBestSurvivalSec, mergeBestSurvivalSec, submitRunResult } from "@bh/core-game";
import { create } from "zustand";
import { z } from "zod/mini";
import { TUTORIAL_DIFFICULTY_ID } from "./difficulty";
import { createPersistedValue } from "./persisted";
import { reportError, useShell } from "./shell";

/**
 * Мета между забегами: локальный рекорд, число забегов, последний выбор
 * оружия (docs/27-design-system-and-app-shell.md §7). Сложность игрок не
 * выбирает: рекорд ведётся по единой (`state/difficulty.ts`).
 *
 * Рекорд ведёт движок (`submitRunResult`): он же считает итог забега, и
 * правило «рекорд — это лучшее время выживания» живёт в одном месте.
 * Оболочка хранит остальное и отдаёт движку порт хранилища.
 */
const META_KEY = "bh.meta.v1.profile";

const schema = z.object({
  runs: z.int().check(z.nonnegative()),
  /** запомненный выбор оружия — решение Р12 */
  lastWeaponId: z.string(),
  /** читается и игнорируется: до единой сложности игрок выбирал её сам */
  lastDifficultyId: z.optional(z.enum(DIFFICULTY_IDS)),
  /** последний засчитанный забег — «до рекорда не хватило 0:42» на главной; до WP42 поля не было */
  lastRun: z.optional(z.object({ difficultyId: z.enum(DIFFICULTY_IDS), survivalSec: z.number().check(z.nonnegative()) })),
  /** раскрыт ли «Подробнее» на экране смерти; старый снимок без поля — свёрнуто */
  deathDetailsOpen: z.optional(z.boolean()),
});

type StoredMeta = z.infer<typeof schema>;

export type BestByDifficulty = Record<DifficultyId, number>;

/** Последний засчитанный забег на этом устройстве. */
export interface LastRun {
  difficultyId: DifficultyId;
  survivalSec: number;
}

export interface MetaStore {
  runs: number;
  lastWeaponId: string;
  /** лучшее время выживания по каждому id сложности; 0 — рекорда нет. Показывается рекорд единой */
  best: BestByDifficulty;
  /** последний засчитанный забег; `null` — на этом устройстве ещё не играли */
  lastRun: LastRun | null;
  /** «Подробнее» на экране смерти раскрыто — помнится на устройстве */
  deathDetailsOpen: boolean;
  hydrate(): void;
  rememberWeapon(weaponId: string): void;
  rememberDeathDetails(open: boolean): void;
  /**
   * записать итог забега; возвращает `true`, если это новый рекорд. Обучающий
   * забег только увеличивает счётчик: он не рекорд и не «последний забег».
   */
  submitRun(result: RunResult, countInRating?: boolean): boolean;
  /**
   * Слить рекорды и счётчик забегов с сервера: игрок, сыгравший на телефоне,
   * видит тот же лучший забег на планшете. Берётся лучшее из двух.
   */
  mergeRemote(remote: { runs?: number; best: Partial<Record<DifficultyId, number>> }): void;
}

export const useMeta = create<MetaStore>((set, get) => ({
  runs: 0,
  lastWeaponId: "",
  best: emptyBest(),
  lastRun: null,
  deathDetailsOpen: false,

  hydrate(): void {
    const stored = value().read();
    const storage = useShell.getState().storage;
    set({
      runs: stored.runs,
      lastWeaponId: stored.lastWeaponId,
      lastRun: stored.lastRun ?? null,
      deathDetailsOpen: stored.deathDetailsOpen ?? false,
      best: Object.fromEntries(
        DIFFICULTY_IDS.map((id) => [id, loadBestSurvivalSec(storage, id)]),
      ) as BestByDifficulty,
    });
  },

  rememberWeapon(weaponId: string): void {
    set({ lastWeaponId: weaponId });
    persist(get());
  },

  rememberDeathDetails(open: boolean): void {
    set({ deathDetailsOpen: open });
    persist(get());
  },

  submitRun(result: RunResult, countInRating = false): boolean {
    // Забег с читами не двигает ни рекорд, ни счётчик забегов — иначе
    // бессмертный разработчик открыл бы себе все достижения. Кроме случая,
    // когда администратор нарочно проверяет рейтинг.
    if (result.cheats && !countInRating) return false;
    // Обучающий забег (Р126) считается сыгранным, но рекорда не ставит и в
    // «последний забег» не идёт: до него единой сложности далеко, а «Новый
    // рекорд» на первом же забеге обесценил бы настоящий. «Нормальная» из
    // продолженного старого сохранения идёт как раньше.
    if (result.difficultyId === TUTORIAL_DIFFICULTY_ID) {
      set({ runs: get().runs + 1 });
      persist(get());
      return false;
    }
    const record = submitRunResult(useShell.getState().storage, result);
    set({
      runs: get().runs + 1,
      best: { ...get().best, [result.difficultyId]: record.bestSurvivalSec },
      lastRun: { difficultyId: result.difficultyId, survivalSec: result.survivalSec },
    });
    persist(get());
    return record.isNewRecord;
  },

  mergeRemote(remote): void {
    const storage = useShell.getState().storage;
    const best = { ...get().best };
    for (const id of DIFFICULTY_IDS) {
      const seconds = remote.best[id];
      // Рекорд пишется и в хранилище устройства, а не только в стор: иначе
      // следующий забег сравнивался бы с местным рекордом и «Новый рекорд»
      // загорался бы на результате хуже серверного.
      if (seconds !== undefined) best[id] = mergeBestSurvivalSec(storage, id, seconds);
    }
    set({ best, runs: Math.max(get().runs, remote.runs ?? 0) });
    persist(get());
  },
}));

/** Лучшее время на любой сложности — для достижений «продержись N минут». */
export function bestOverall(best: BestByDifficulty): number {
  return Math.max(...DIFFICULTY_IDS.map((id) => best[id]));
}

function emptyBest(): BestByDifficulty {
  return { easy: 0, normal: 0, hard: 0 };
}

function value(): ReturnType<typeof createPersistedValue<StoredMeta>> {
  return createPersistedValue<StoredMeta>({
    storage: useShell.getState().storage,
    key: META_KEY,
    schema,
    fallback: { runs: 0, lastWeaponId: "" },
    onBroken: (key, reason) => reportError("meta", `${key}: ${reason}`),
  });
}

function persist(state: MetaStore): void {
  value().write({
    runs: state.runs,
    lastWeaponId: state.lastWeaponId,
    ...(state.lastRun === null ? {} : { lastRun: state.lastRun }),
    deathDetailsOpen: state.deathDetailsOpen,
  });
}
