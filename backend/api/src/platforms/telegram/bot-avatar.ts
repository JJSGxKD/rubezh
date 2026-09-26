import { PALETTE, renderPng } from "../../common/card/svg.js";

/**
 * Фото профиля бота — знак игры с главного экрана: ромб-рубеж с горизонтом в
 * золотом градиенте и ореоле (`app-shell/src/design-system/components/Brand.tsx`).
 * Рисуется тем же resvg, что карточки: фото меняется правкой здесь, без
 * ручной загрузки в BotFather. Содержимое квадрата держится в круге —
 * Telegram обрезает фото профиля кругом.
 */
const SIZE = 1024;

/** Градиент знака — токены `accent-glow`, `accent`, `accent-edge` дизайн-системы. */
const GOLD = { glow: "#ffd27a", accent: PALETTE.accent, edge: "#a85a06" } as const;

export const BOT_AVATAR_SVG = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
  "<defs>",
  `<radialGradient id="halo" cx="512" cy="512" r="455" gradientUnits="userSpaceOnUse">`,
  `<stop offset="0" stop-color="${GOLD.accent}" stop-opacity="0.6"/>`,
  `<stop offset="0.55" stop-color="${GOLD.accent}" stop-opacity="0.22"/>`,
  `<stop offset="1" stop-color="${GOLD.accent}" stop-opacity="0"/>`,
  "</radialGradient>",
  `<linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">`,
  `<stop offset="0" stop-color="${GOLD.glow}"/><stop offset="0.55" stop-color="${GOLD.accent}"/><stop offset="1" stop-color="${GOLD.edge}"/>`,
  "</linearGradient>",
  "</defs>",
  `<rect width="${SIZE}" height="${SIZE}" fill="${PALETTE.bg}"/>`,
  `<circle cx="512" cy="512" r="455" fill="url(#halo)"/>`,
  `<g transform="translate(512 512) scale(8.5) translate(-32 -32)">`,
  `<path d="M32 4 L60 32 L32 60 L4 32 Z" fill="none" stroke="url(#gold)" stroke-width="4" stroke-linejoin="round"/>`,
  `<path d="M32 16 L48 32 L32 48 L16 32 Z" fill="url(#gold)"/>`,
  `<path d="M10 32 H54" stroke="${PALETTE.bg}" stroke-width="3"/>`,
  "</g>",
  "</svg>",
].join("");

export function renderBotAvatar(): Buffer {
  return renderPng(BOT_AVATAR_SVG);
}
