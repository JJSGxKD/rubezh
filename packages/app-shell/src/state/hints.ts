import type { HudSnapshot } from "@bh/core-game";
import { create } from "zustand";
import { z } from "zod/mini";
import { createPersistedValue } from "./persisted";
import { reportError, useShell } from "./shell";

/**
 * Подсказки первого забега: как двигаться, зачем кристаллы, что делать дальше.
 *
 * Подсказка гаснет не по таймеру, а когда игрок сделал то, о чём она: пошёл —
 * значит, понял управление. Усвоенная подсказка запоминается на устройстве и
 * больше не показывается; вернуть все можно в настройках.
 *
 * Условия считаются по снимку HUD — оболочка мир не читает
 * (docs/27-design-system-and-app-shell.md §3.1).
 */
const HINTS_KEY = "bh.hints.v1";

export const HINT_ORDER = ["move", "gems", "dodge"] as const;
export type HintId = (typeof HINT_ORDER)[number];

/** Сколько игровых единиц пройти, чтобы подсказка про движение считалась усвоенной. */
const MOVE_DONE_UNITS = 140;
/** Последняя подсказка — совет, а не действие: она держится столько секунд забега. */
const DODGE_SHOW_SEC = 6;

const schema = z.object({ seen: z.array(z.enum(HINT_ORDER)) });

/** Первая неусвоенная подсказка или `null`, если игрок прошёл все. */
export function currentHint(seen: readonly HintId[]): HintId | null {
  return HINT_ORDER.find((id) => !seen.includes(id)) ?? null;
}

/**
 * Выполнил ли игрок подсказку. `shownSinceSec` — секунда забега, на которой
 * подсказка появилась: у совета без действия важно, сколько он провисел.
 */
export function isHintDone(id: HintId, hud: HudSnapshot, shownSinceSec: number): boolean {
  switch (id) {
    case "move":
      return hud.distance >= MOVE_DONE_UNITS;
    case "gems":
      return hud.xp > 0 || hud.level > 1;
    default:
      return hud.survivalSec - shownSinceSec >= DODGE_SHOW_SEC;
  }
}

export interface HintsStore {
  seen: HintId[];
  hydrate(): void;
  markSeen(id: HintId): void;
  /** показать подсказки заново — из настроек */
  reset(): void;
}

export const useHints = create<HintsStore>((set, get) => ({
  seen: [],

  hydrate(): void {
    set({ seen: value().read().seen });
  },

  markSeen(id): void {
    if (get().seen.includes(id)) return;
    const seen = [...get().seen, id];
    set({ seen });
    value().write({ seen });
  },

  reset(): void {
    set({ seen: [] });
    value().write({ seen: [] });
  },
}));

function value(): ReturnType<typeof createPersistedValue<{ seen: HintId[] }>> {
  return createPersistedValue<{ seen: HintId[] }>({
    storage: useShell.getState().storage,
    key: HINTS_KEY,
    schema,
    fallback: { seen: [] },
    onBroken: (key, reason) => reportError("hints", `${key}: ${reason}`),
  });
}
