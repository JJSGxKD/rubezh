/** Масштаб холста редактора: 25…200 % (tasks/T-0274). */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;
/** Шаг кнопок «+» и «−». */
export const ZOOM_STEP = 0.25;

export interface Size {
  width: number;
  height: number;
}

export const clampZoom = (zoom: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

/**
 * «Вписать»: масштаб, при котором холст целиком влезает в окно. Окно нулевое
 * (ещё не измерено) — минимум: лучше мелко, чем холст, выпирающий за экран.
 */
export function fitZoom(canvas: Size, viewport: Size): number {
  if (viewport.width <= 0 || viewport.height <= 0 || canvas.width <= 0 || canvas.height <= 0) return ZOOM_MIN;
  const fit = Math.min(viewport.width / canvas.width, viewport.height / canvas.height);
  // Сотые доли: «49,87 %» в подписи кнопки ни к чему.
  return clampZoom(Math.floor(fit * 100) / 100);
}
