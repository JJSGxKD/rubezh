import { DIFFICULTY_IDS, type DifficultyId, type RunResult } from "@bh/shared-types";
import { DEFAULT_DIFFICULTY_ID, loadBestSurvivalSec, mergeBestSurvivalSec, submitRunResult } from "@bh/core-game";
import { create } from "zustand";
import { z } from "zod/mini";
import { createPersistedValue } from "./persisted";
import { reportError, useShell } from "./shell";

/**
 * Мета между забегами: локальные рекорды по сложностям, число забегов,
 * последний выбор оружия и сложности (docs/27-design-system-and-app-shell.md §7).
 *
 * Рекорд ведёт движок (`submitRunResult`): он же считает итог забега, и
 * правило «рекорд — это лучшее время выживания на этой сложности» живёт в
 * одном месте. Оболочка хранит остальное и отдаёт движку порт хранилища.
 */
const META_KEY = "bh.meta.v1.profile";

const schema = z.object({
  runs: z.int().check(z.nonnegative()),
  /** запомненный выбор оружия — решение Р12 */
  lastWeaponId: z.string(),
  /** запомненный выбор сложности; до появления сложностей поля не было */
  lastDifficultyId: z.optional(z.enum(DIFFICULTY_IDS)),
});

type StoredMeta = z.infer<typeof schema>;

export type BestByDifficulty = Record<DifficultyId, number>;

export interface MetaStore {
  runs: number;
  lastWeaponId: string;
  lastDifficultyId: DifficultyId;
  /** лучшее время выживания на каждой сложности; 0 — рекорда нет */
  best: BestByDifficulty;
  hydrate(): void;
  rememberWeapon(weaponId: string): void;
  rememberDifficulty(difficultyId: DifficultyId): void;
  /** записать итог забега; возвращает `true`, если это новый рекорд его сложности */
  submitRun(result: RunResult): boolean;
  /**
   * Слить рекорды и счётчик забегов с сервера: игрок, сыгравший на телефоне,
   * видит тот же лучший забег на планшете. Берётся лучшее из двух.
   */
  mergeRemote(remote: { runs?: number; best: Partial<Record<DifficultyId, number>> }): void;
}

export const useMeta = create<MetaStore>((set, get) => ({
  runs: 0,
  lastWeaponId: "",
  lastDifficultyId: DEFAULT_DIFFICULTY_ID,
  best: emptyBest(),

  hydrate(): void {
    const stored = value().read();
    const storage = useShell.getState().storage;
    set({
      runs: stored.runs,
      lastWeaponId: stored.lastWeaponId,
      lastDifficultyId: stored.lastDifficultyId ?? DEFAULT_DIFFICULTY_ID,
      best: Object.fromEntries(
        DIFFICULTY_IDS.map((id) => [id, loadBestSurvivalSec(storage, id)]),
      ) as BestByDifficulty,
    });
  },

  rememberWeapon(weaponId: string): void {
    set({ lastWeaponId: weaponId });
    persist(get());
  },

  rememberDifficulty(difficultyId: DifficultyId): void {
    set({ lastDifficultyId: difficultyId });
    persist(get());
  },

  submitRun(result: RunResult): boolean {
    const record = submitRunResult(useShell.getState().storage, result);
    set({
      runs: get().runs + 1,
      best: { ...get().best, [result.difficultyId]: record.bestSurvivalSec },
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
    lastDifficultyId: state.lastDifficultyId,
  });
}
