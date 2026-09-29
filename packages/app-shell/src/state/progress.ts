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
  /**
   * С каким уровнем аккаунта пойдёт следующий забег — из подписанного снимка
   * на устройстве (WP25): тот же уровень получит движок, поэтому экран выбора
   * оружия открывает ровно то, что откроет забег. `null` — снимок ещё не
   * читали.
   */
  runLevel: number | null;
}

export const useProgress = create<ProgressState>()(() => ({ progress: null, rewards: {}, runLevel: null }));
