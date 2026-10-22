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
  bg: "#1d1c31",
  surface: "#28273f",
  raised: "#353452",
  sunken: "#17162a",
  border: "#43425f",
  text: "#f3eee6",
  muted: "#aeaac4",
  faint: "#6f6c8a",
  accent: "#ff8f3f",
  secondary: "#46d9c6",
  elite: "#ffd15c",
  danger: "#ff5d5d",
  success: "#8ee86b",
} as const;

/** Цвета долей в полосах: соседние доли различимы и на сжатом Telegram'ом фото. */
export const SERIES = ["#5ccfff", "#ffd15c", "#8ee86b", "#c47dff", "#ff8f3f", "#aeaac4"] as const;

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
export function estimateWidth(value: string, size: number, bold = false): number {
  return value.length * size * (bold ? 0.63 : 0.55);
}

/**
 * Строка по словам на строки не шире `maxWidth` — по той же оценке ширины:
 * у resvg нет переноса, а длинная подпись ушла бы под рисунок карточки.
 */
export function wrapWords(value: string, size: number, maxWidth: number, bold = false): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of value.split(" ")) {
    const next = line === "" ? word : `${line} ${word}`;
    if (line !== "" && estimateWidth(next, size, bold) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

export function svgDocument(width: number, height: number, parts: readonly string[]): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    rect(0, 0, width, height, { fill: PALETTE.bg }),
    ...parts,
    "</svg>",
  ].join("\n");
}

/**
 * Вставка готового рисунка (знак, портрет облика из `brand-art.ts`) картинкой:
 * у вложенного SVG свой документ, и его градиенты и фильтры не спорят с
 * разметкой карточки.
 */
export function svgImage(svg: string, x: number, y: number, width: number, height: number): string {
  return `<image x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" href="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"/>`;
}

/**
 * Фон «Сумеречного рубежа»: небо, жар очага снизу и частокол по нижнему краю
 * — тот же мир, что за экранами игры (direction-v2.md §4.4). Звёзды стоят на
 * местах по сетке, без случайности: одинаковые данные — одинаковая картинка.
 */
export function twilightBackdrop(width: number, height: number, options: { stakes?: boolean; starsFrom?: number } = {}): string[] {
  const parts = [
    `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a2860"/><stop offset="0.6" stop-color="${PALETTE.bg}"/><stop offset="1" stop-color="#120f1e"/></linearGradient>`,
    `<radialGradient id="hearth" cx="0.5" cy="1" r="0.7"><stop offset="0" stop-color="${PALETTE.accent}" stop-opacity="0.35"/><stop offset="1" stop-color="${PALETTE.accent}" stop-opacity="0"/></radialGradient></defs>`,
    rect(0, 0, width, height, { fill: "url(#sky)" }),
    rect(0, 0, width, height, { fill: "url(#hearth)" }),
  ];
  for (let k = 0; k < 14; k++) {
    const x = ((k * 263) % 997) / 997;
    const y = ((k * 149) % 541) / 541;
    // Звёзды — правее `starsFrom` (доля ширины): над колонкой текста они ложились бы на буквы.
    const from = options.starsFrom ?? 0;
    parts.push(`<circle cx="${round((from + x * (1 - from)) * width)}" cy="${round(y * height * 0.5)}" r="${k % 3 === 0 ? 2.4 : 1.6}" fill="#ffffff" fill-opacity="0.6"/>`);
  }
  if (options.stakes !== false) {
    const stakeW = 44;
    for (let x = -10; x < width; x += stakeW) {
      const h = 70 + (((x + 10) / stakeW) % 4) * 10;
      const top = height - h;
      parts.push(
        `<path d="M${round(x)} ${height}V${round(top + 18)}L${round(x + stakeW / 2 - 2)} ${round(top)}L${round(x + stakeW - 4)} ${round(top + 18)}V${height}Z" fill="#0d0a18" stroke="${PALETTE.accent}" stroke-opacity="0.45" stroke-width="2.5"/>`,
      );
    }
  }
  return parts;
}

/** Каталог шрифтов Debian — туда ставит DejaVu пакет из Dockerfile. */
const FONT_DIRS = ["/usr/share/fonts"];

export function renderPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    // Системные шрифты resvg в Linux ищет через конфигурацию fontconfig, а в
    // slim-образе её нет: без явного каталога DejaVu из Dockerfile не находится,
    // и текст на карточке пропадает целиком. Каталога нет (Windows) — не ошибка.
    // Запасная гарнитура — та, что точно есть в прод-образе: Arial в
    // Linux-контейнере не бывает.
    font: { loadSystemFonts: true, fontDirs: FONT_DIRS, defaultFontFamily: "DejaVu Sans" },
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
