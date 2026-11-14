import { qrMatrix, qrPath } from "../ui/qr-code";

/**
 * QR слоя `qr` картинкой из SVG (tasks/T-0274): тёмный на светлом, поле
 * тишины в четыре модуля — оно уже внутри матрицы (`qrMatrix`). Картинка
 * собирается самим редактором из цветов документа, поэтому цвет проверяется:
 * в атрибут SVG не должно попасть ничего, кроме `#rrggbb`.
 *
 * Размер задан стороной слоя в точках: браузер растрирует SVG ровно в него, и
 * при выгрузке модули ложатся без размытых швов.
 */
const COLOR = /^#[0-9a-fA-F]{6}$/;

/** `data:`-адрес SVG; `null` — QR собрать нельзя (адрес слишком длинный или цвет не цвет). */
export function qrImageUrl(data: string, fg: string, bg: string, side: number): string | null {
  if (!COLOR.test(fg) || !COLOR.test(bg) || !Number.isFinite(side) || side <= 0) return null;
  let matrix: boolean[][];
  try {
    matrix = qrMatrix(data);
  } catch {
    // Адрес не влез в самый большой QR: слою нечего кодировать, редактор покажет заглушку.
    return null;
  }
  const modules = matrix.length;
  const size = String(Math.round(side));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${String(modules)} ${String(modules)}" shape-rendering="crispEdges">` +
    `<rect width="${String(modules)}" height="${String(modules)}" fill="${bg}"/>` +
    `<path d="${qrPath(matrix)}" fill="${fg}"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
