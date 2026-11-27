import { containFit } from "./fabric-doc";

/**
 * Логотип слоя `logo` (tasks/T-0274): файлы знака игры (`packages/app-shell/src/
 * design-system/brand/`) без правки. У них есть только `viewBox`, а холсту
 * нужен размер в точках: без него браузер растрирует знак по умолчанию и
 * растягивает — выходит мыло. Редактор дописывает `width` и `height` и отдаёт
 * картинку ровно того размера, в который знак ляжет в рамку слоя.
 */
export interface LogoImage {
  url: string;
  width: number;
  height: number;
}

/** Размер из `viewBox="x y w h"`; `null` — разметка не похожа на знак. */
function viewBoxSize(svg: string): { width: number; height: number } | null {
  const match = /<svg\b[^>]*\sviewBox="\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(svg);
  if (match === null) return null;
  const width = Number(match[3]);
  const height = Number(match[4]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Знак, вписанный в рамку: размер — по пропорциям `viewBox`, картинка — `data:`-адрес. */
export function logoImage(svg: string, box: { width: number; height: number }): LogoImage | null {
  const natural = viewBoxSize(svg);
  if (natural === null || box.width <= 0 || box.height <= 0) return null;
  const fitted = containFit(natural, box);
  const width = Math.max(1, Math.round(fitted.width));
  const height = Math.max(1, Math.round(fitted.height));
  const sized = svg.replace(/<svg\b/, `<svg width="${String(width)}" height="${String(height)}"`);
  return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`, width, height };
}
