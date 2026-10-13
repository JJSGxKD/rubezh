import { useMemo } from "react";
import { encode } from "uqr";

/**
 * QR для входа в панель (tasks/T-0056): телефон сканирует его и сразу попадает
 * в бота с тем же запросом. Рисуется SVG с одним `<path>` — без вставки
 * разметки строкой: политика источников панели и React без неё обходятся.
 */

/** Поле вокруг кода — четыре модуля, как требует сканер. */
const QUIET_ZONE = 4;
/** Тёмный QR на тёмном фоне сканеры читают плохо, поэтому код лежит на светлой плитке. */
const DARK = "#0d0c18";

/** Матрица модулей для строки: уровень коррекции M, поле вокруг уже внутри. */
export function qrMatrix(value: string): boolean[][] {
  return encode(value, { ecc: "M", border: QUIET_ZONE, boostEcc: false }).data;
}

/** Модули QR одной строкой пути SVG: квадрат 1×1 на каждый тёмный модуль. */
export function qrPath(modules: readonly (readonly boolean[])[]): string {
  const squares: string[] = [];
  modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) squares.push(`M${String(x)} ${String(y)}h1v1h-1z`);
    });
  });
  return squares.join("");
}

export function QrCode({ value, size = 200, label }: { value: string; size?: number; label: string }) {
  const matrix = useMemo(() => qrMatrix(value), [value]);
  const side = matrix.length;
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${String(side)} ${String(side)}`} width={size} height={size} className="rounded-md bg-white" shapeRendering="crispEdges">
      <path d={qrPath(matrix)} fill={DARK} />
    </svg>
  );
}
