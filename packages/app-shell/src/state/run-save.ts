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
 * после обновления игры числа врагов и оружия другие, и такое сохранение не
 * продолжается криво. Но и не пропадает молча: пока забег не засчитан, запись
 * лежит на устройстве, а `settleInterruptedRun` (`run-interrupted.ts`) забирает
 * её через `takeIncompatibleRun` и отправляет брошенным забегом.
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
    // Счётчики есть у снимков этой сборки и новее; у прошлой их нет — тогда
    // убийства читаются из тела мира (`readSnapshotCounters`).
    enemiesKilled: z.optional(z.number()),
    xpCollected: z.optional(z.number()),
  }),
  // Состояние мира проверяет сам движок: его формат знает только он.
  world: z.unknown(),
  // Признаки режима перечислены явно: схема отбрасывает всё, чего не знает, и
  // молча забытый признак превращал продолженный забег разработчика в обычный.
  cheats: z.optional(z.boolean()),
  dev: z.optional(z.boolean()),
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
    // Несовместимое сохранение не предлагается к продолжению, но и не стирается:
    // его заберёт `settleInterruptedRun`, а пока забег не засчитан, он единственный.
    set({ saved: stored !== null && !isResumable(stored) ? null : stored });
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

/**
 * Забрать сохранение, которое на этой сборке не продолжается (другой формат
 * или контент): запись стирается, а то, что в ней было, возвращается тому, кто
 * засчитает забег. Совместимое сохранение не трогается — `null`.
 */
export function takeIncompatibleRun(): SavedRun | null {
  const stored = value().read();
  if (stored === null || isResumable(stored)) return null;
  value().write(null);
  return stored;
}

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
