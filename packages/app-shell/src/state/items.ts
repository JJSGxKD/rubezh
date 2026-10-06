import { create } from "zustand";
import type { InventoryView } from "./items-api";

export type { InventoryView, ItemView } from "./items-api";

/**
 * Инвентарь игрока (docs/35-stage4-plan.md §3.4, WP7) — только состояние.
 * Запросы и схемы — `items-api.ts`, снимок надетого на устройстве —
 * `run-loadouts.ts`; оба отдельными чанками.
 *
 * Инвентарь живёт в памяти: его показывает арсенал, и он всегда свежий с
 * сервера.
 */

interface ItemsState {
  /** `null` — ещё не спрашивали или сервер не ответил */
  inventory: InventoryView | null;
}

export const useItems = create<ItemsState>()(() => ({ inventory: null }));
