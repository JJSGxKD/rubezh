import { Resvg } from "@resvg/resvg-js";

/**
 * Карточки бота — сводка, приветствие, уведомления — это SVG-шаблоны,
 * растеризуемые в PNG. Здесь общее: палитра, текст, прямоугольники и
 * растеризация.
 *
 * Цвета повторяют направление дизайн-системы клиента
 * (`app-shell/src/design-system/tokens.css`): бэкенд не читает CSS, поэтому
 * значения продублированы здесь и меняются вместе с токенами.
 */

export const PALETTE = {
  bg: "#07090e",
  surface: "#121622",
  raised: "#1b2130",
  border: "#262e40",
  text: "#f3f6fc",
  muted: "#a8b2c6",
  faint: "#69738a",
  accent: "#ffb22e",
  danger: "#ff5d5d",
  success: "#5fe3a1",
} as const;

/** Цвета долей в полосах: соседние доли различимы и на сжатом Telegram'ом фото. */
export const SERIES = ["#5ccfff", "#ffb22e", "#5fe3a1", "#c47dff", "#ff8c42", "#a8b2c6"] as const;

/**
 * Системные гарнитуры с кириллицей по убыванию вероятности: Windows у
 * разработчика, Roboto и DejaVu в Linux-контейнере (docs/20-env-and-ports.md).
 */
export const FONT = "Segoe UI, Roboto, DejaVu Sans, Arial, sans-serif";

export interface TextStyle {
  size: number;
  fill: string;
  weight?: number;
  spacing?: number;
  anchor?: "start" | "middle" | "end";
}

export function text(x: number, y: number, value: string, style: TextStyle): string {
  const attributes = [
    `x="${round(x)}"`,
    `y="${round(y)}"`,
    `font-family="${FONT}"`,
    `font-size="${style.size}"`,
    `fill="${style.fill}"`,
    style.weight === undefined ? "" : `font-weight="${style.weight}"`,
    style.spacing === undefined ? "" : `letter-spacing="${style.spacing}"`,
    style.anchor === undefined || style.anchor === "start" ? "" : `text-anchor="${style.anchor}"`,
  ].filter((attribute) => attribute !== "");
  return `<text ${attributes.join(" ")}>${escapeXml(value)}</text>`;
}

export function rect(x: number, y: number, width: number, height: number, style: { fill: string; stroke?: string; radius?: number }): string {
  const attributes = [
    `x="${round(x)}"`,
    `y="${round(y)}"`,
    `width="${round(width)}"`,
    `height="${round(height)}"`,
    `fill="${style.fill}"`,
    style.radius === undefined ? "" : `rx="${style.radius}"`,
    style.stroke === undefined ? "" : `stroke="${style.stroke}" stroke-width="2"`,
  ].filter((attribute) => attribute !== "");
  return `<rect ${attributes.join(" ")}/>`;
}

/**
 * Ширина подписи без измерения шрифта: у resvg нет метрик до отрисовки.
 * Средняя ширина знака ≈ 0,55 кегля — с запасом для кириллицы.
 */
export function estimateWidth(value: string, size: number): number {
  return value.length * size * 0.55;
}

export function svgDocument(width: number, height: number, parts: readonly string[]): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    rect(0, 0, width, height, { fill: PALETTE.bg }),
    ...parts,
    "</svg>",
  ].join("\n");
}

export function renderPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    // Запасная гарнитура — та, что точно есть в прод-образе (Dockerfile):
    // Arial в Linux-контейнере не бывает.
    font: { loadSystemFonts: true, defaultFontFamily: "DejaVu Sans" },
    fitTo: { mode: "original" },
  });
  return resvg.render().asPng();
}

export function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Ключи, имена и причины приходят снаружи — в разметку только экранированными. */
export function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
