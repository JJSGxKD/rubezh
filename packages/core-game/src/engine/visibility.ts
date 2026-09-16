import type { FrameClock } from "../game/diagnostics/frame-clock";

/**
 * Сворачивание приложения → часы кадров. Отдельно от часов: они проверяются
 * на синтетических кадрах, а документ есть только в браузере.
 */
export function watchVisibility(clock: FrameClock): () => void {
  if (typeof document === "undefined") return () => undefined;
  const handler = (): void => {
    if (document.hidden) clock.hide();
    else clock.show();
  };
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}
