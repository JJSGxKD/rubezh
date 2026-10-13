import { useSyncExternalStore } from "react";

/** Узкий экран — до 768 px: меню листом, таблицы карточками, окна листом снизу. */
export const NARROW_QUERY = "(max-width: 767.98px)";

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(NARROW_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** Окна нет (тесты, сборка) — считаем экран широким: ПК-раскладка безопаснее. */
function snapshot(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches;
}

export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
