import { create } from "zustand";
import type { ProgressView, RunRewardView } from "./progress-api";

/**
 * Уровень аккаунта и награда за забег (docs/35-stage4-plan.md, WP4) — только
 * состояние. Запросы и схемы ответа — в `progress-api.ts`, отдельным чанком:
 * экран итогов и профиль читают это хранилище с первой загрузки, а сам
 * запрос нужен только после забега и в профиле
 * (docs/27-design-system-and-app-shell.md §3.4).
 */

export type { ProgressView, RunRewardView } from "./progress-api";

interface ProgressState {
  progress: ProgressView | null;
  /** награда по забегу; нет ключа — не спрашивали, `pending` — ещё считается */
  rewards: Record<string, RunRewardView>;
}

export const useProgress = create<ProgressState>()(() => ({ progress: null, rewards: {} }));
