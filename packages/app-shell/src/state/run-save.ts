import { DIFFICULTY_IDS } from "@bh/shared-types";
import { CONTENT_HASH, RUN_SNAPSHOT_FORMAT, type RunSnapshot } from "@bh/core-game";
import { create } from "zustand";
import { z } from "zod/mini";
import { createPersistedValue } from "./persisted";
import { reportError, useShell } from "./shell";

/**
 * Сохранение прерванного забега (docs/27-design-system-and-app-shell.md §7).
 *
 * Забег, прерванный сворачиванием, вылетом или закрытием приложения, не
 * пропадает: движок отдаёт снимок, оболочка кладёт его на устройство, и в
 * лобби появляется «Продолжить». Сохранение одно — забег у игрока тоже один.
 *
 * Снимок годится только для той версии контента и формата, на которой снят:
 * после обновления игры числа врагов и оружия другие, и такое сохранение
 * молча удаляется, а не продолжается криво.
 */
const SAVE_KEY = "bh.run.v1.save";

const slotSchema = z.object({ id: z.string(), level: z.number() });

const savedRunSchema = z.object({
  format: z.number(),
  contentHash: z.string(),
  runId: z.string(),
  seed: z.number(),
  mapId: z.string(),
  difficultyId: z.enum(DIFFICULTY_IDS),
  startingWeaponId: z.string(),
  summary: z.object({
    survivalSec: z.number(),
    level: z.number(),
    weapons: z.array(slotSchema),
    passives: z.array(slotSchema),
  }),
  // Состояние мира проверяет сам движок: его формат знает только он.
  world: z.unknown(),
  /** когда сохранено, мс UTC — для подписи в лобби */
  savedAt: z.number(),
});

export type SavedRun = z.infer<typeof savedRunSchema> & RunSnapshot;

export interface SavedRunStore {
  saved: SavedRun | null;
  hydrate(): void;
  save(snapshot: RunSnapshot): void;
  clear(): void;
}

export const useSavedRun = create<SavedRunStore>((set) => ({
  saved: null,

  hydrate(): void {
    const stored = value().read();
    if (stored !== null && !isResumable(stored)) {
      value().write(null);
      set({ saved: null });
      return;
    }
    set({ saved: stored });
  },

  save(snapshot): void {
    const saved: SavedRun = { ...snapshot, savedAt: Date.now() };
    value().write(saved);
    set({ saved });
  },

  clear(): void {
    if (useSavedRun.getState().saved === null) return;
    value().write(null);
    set({ saved: null });
  },
}));

/** Можно ли продолжить сохранение на этой сборке. */
export function isResumable(saved: Pick<RunSnapshot, "format" | "contentHash">): boolean {
  return saved.format === RUN_SNAPSHOT_FORMAT && saved.contentHash === CONTENT_HASH;
}

function value(): ReturnType<typeof createPersistedValue<SavedRun | null>> {
  return createPersistedValue<SavedRun | null>({
    storage: useShell.getState().storage,
    key: SAVE_KEY,
    schema: z.nullable(savedRunSchema) as z.ZodMiniType<SavedRun | null>,
    fallback: null,
    onBroken: (key, reason) => reportError("run-save", `${key}: ${reason}`),
  });
}
