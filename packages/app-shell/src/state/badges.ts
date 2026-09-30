import { create } from "zustand";

/**
 * Знаки меню (docs/35-stage4-plan.md Р50, §3.17) — только числа: новые
 * предметы на вкладке арсенала, подарки и заявки друзей, непрочитанное на
 * колокольчике, незабранная награда дня на плитке главной, новые версии в
 * «Что нового» в меню. Приходят одним запросом (`badges-api.ts`, отдельным чанком):
 * первой загрузке нужны только числа, и то после входа.
 */
export interface Badges {
  notifications: number;
  arsenal: number;
  friends: number;
  daily: number;
  changelog: number;
}

export const useBadges = create<Badges>()(() => ({ notifications: 0, arsenal: 0, friends: 0, daily: 0, changelog: 0 }));

/** Текст знака: ноль — знака нет, больше девяти — «9+». */
export function badgeText(count: number): string | undefined {
  if (count <= 0) return undefined;
  return count > 9 ? "9+" : String(count);
}
