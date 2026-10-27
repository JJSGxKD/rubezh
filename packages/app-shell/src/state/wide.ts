import { create } from "zustand";
import { WIDE_MEDIA_QUERY } from "../design-system/components/wide-rules";

/**
 * Класс ширины `wide` (с 1024 px, docs/27-design-system-and-app-shell.md §5.3).
 * Состояние меняется только при смене класса, а не на каждый пиксель ресайза:
 * оболочка не перерисовывается чаще, чем окно пересекает порог.
 */
export interface WideState {
  wide: boolean;
}

/** Минимум от `MediaQueryList`, чтобы слежение проверялось без браузера. */
export interface WideMedia {
  matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

/**
 * Сообщает текущее значение сразу и каждую смену класса; повторы без смены
 * молчат. Возвращает отписку.
 */
export function watchWide(media: WideMedia, apply: (wide: boolean) => void): () => void {
  let last = media.matches;
  apply(last);
  const onChange = (): void => {
    if (media.matches === last) return;
    last = media.matches;
    apply(last);
  };
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function browserMedia(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(WIDE_MEDIA_QUERY);
}

// Начальное значение — из браузера сразу, до первой отрисовки: оболочка не
// мигает нижней панелью на мониторе. Вне браузера (тесты, сервер) — телефон.
const media = browserMedia();

export const useWide = create<WideState>(() => ({ wide: media?.matches ?? false }));

if (media !== null) watchWide(media, (wide) => useWide.setState({ wide }));
