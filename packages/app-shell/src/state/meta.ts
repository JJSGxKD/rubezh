import type { RunResult } from "@bh/shared-types";
import { loadBestSurvivalSec, submitRunResult } from "@bh/core-game";
import { create } from "zustand";
import { z } from "zod/mini";
import { createPersistedValue } from "./persisted";
import { reportError, useShell } from "./shell";

/**
 * Мета между забегами: локальный рекорд, число забегов, последнее стартовое
 * оружие (docs/27-design-system-and-app-shell.md §7).
 *
 * Рекорд ведёт движок (`submitRunResult`): он же считает итог забега, и
 * правило «рекорд — это лучшее время выживания» живёт в одном месте. Оболочка
 * хранит остальное и отдаёт движку порт хранилища.
 */
const META_KEY = "bh.meta.v1.profile";

const schema = z.object({
  runs: z.int().check(z.nonnegative()),
  /** запомненный выбор оружия — решение Р12 */
  lastWeaponId: z.string(),
});

type StoredMeta = z.infer<typeof schema>;

export interface MetaStore extends StoredMeta {
  bestSurvivalSec: number;
  hydrate(): void;
  rememberWeapon(weaponId: string): void;
  /** записать итог забега; возвращает `true`, если это новый рекорд */
  submitRun(result: RunResult): boolean;
}

export const useMeta = create<MetaStore>((set, get) => ({
  runs: 0,
  lastWeaponId: "",
  bestSurvivalSec: 0,

  hydrate(): void {
    const stored = value().read();
    set({
      runs: stored.runs,
      lastWeaponId: stored.lastWeaponId,
      bestSurvivalSec: loadBestSurvivalSec(useShell.getState().storage),
    });
  },

  rememberWeapon(weaponId: string): void {
    set({ lastWeaponId: weaponId });
    persist(get());
  },

  submitRun(result: RunResult): boolean {
    const record = submitRunResult(useShell.getState().storage, result);
    set({ runs: get().runs + 1, bestSurvivalSec: record.bestSurvivalSec });
    persist(get());
    return record.isNewRecord;
  },
}));

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
  value().write({ runs: state.runs, lastWeaponId: state.lastWeaponId });
}
