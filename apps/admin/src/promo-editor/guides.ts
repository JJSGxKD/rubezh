/**
 * Направляющие к центру и краям холста при перетаскивании (tasks/T-0274).
 * Чистая функция: по прямоугольнику слоя и размеру холста — на сколько его
 * подвинуть и какие линии показать.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Snap {
  dx: number;
  dy: number;
  /** x вертикальных линий, точек холста */
  vertical: number[];
  /** y горизонтальных линий, точек холста */
  horizontal: number[];
}

/** Притяжение, экранных точек: при любом масштабе рука ловит линию одинаково. */
export const SNAP_SCREEN_PX = 8;

/** Ближайшая цель для трёх опорных линий слоя (начало, середина, конец); `null` — далеко. */
function nearest(starts: readonly [number, number, number], targets: readonly number[], threshold: number): { shift: number; line: number } | null {
  let best: { shift: number; line: number } | null = null;
  for (const start of starts) {
    for (const target of targets) {
      const shift = target - start;
      if (Math.abs(shift) > threshold) continue;
      if (best === null || Math.abs(shift) < Math.abs(best.shift)) best = { shift, line: target };
    }
  }
  return best;
}

export function snapBox(box: Box, canvas: { width: number; height: number }, threshold: number): Snap {
  const x = nearest([box.x, box.x + box.width / 2, box.x + box.width], [0, canvas.width / 2, canvas.width], threshold);
  const y = nearest([box.y, box.y + box.height / 2, box.y + box.height], [0, canvas.height / 2, canvas.height], threshold);
  return {
    dx: x?.shift ?? 0,
    dy: y?.shift ?? 0,
    vertical: x === null ? [] : [x.line],
    horizontal: y === null ? [] : [y.line],
  };
}
