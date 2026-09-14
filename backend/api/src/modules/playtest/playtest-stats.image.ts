import { Resvg } from "@resvg/resvg-js";
import type { Difficulty } from "./playtest.store";
import type { Share, StatsSummary } from "./playtest-stats.summary";

/**
 * Сводка плейтеста картинкой: SVG-шаблон и растеризация в PNG.
 *
 * Картинка, а не текст: распределения по устройствам и длине забега читаются
 * полосами за секунду, а таблица из цифр в чате — нет. Та же сводка уходит
 * подписью к фото — на случай, если на машине бэкенда нет шрифтов с
 * кириллицей и текст на картинке не отрисуется.
 *
 * Цвета повторяют направление дизайн-системы клиента
 * (`app-shell/src/design-system/tokens.css`): бэкенд не читает CSS, поэтому
 * значения продублированы здесь и меняются вместе с токенами.
 */

const PALETTE = {
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
const SERIES = ["#5ccfff", "#ffb22e", "#5fe3a1", "#c47dff", "#ff8c42", "#a8b2c6"] as const;

/**
 * Системные гарнитуры с кириллицей по убыванию вероятности: Windows у
 * разработчика, Roboto и DejaVu в Linux-контейнере (docs/20-env-and-ports.md).
 */
const FONT = "Segoe UI, Roboto, DejaVu Sans, Arial, sans-serif";

const WIDTH = 1080;
const PAD = 56;
const INNER = WIDTH - PAD * 2;

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

export const DIFFICULTY_LABELS: Record<Difficulty, string> = { easy: "Лёгкая", normal: "Нормальная", hard: "Сложная" };

const OS_LABELS: Record<string, string> = {
  android: "Android",
  ios: "iOS",
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  other: "Другая",
};

const FORM_FACTOR_LABELS: Record<string, string> = { phone: "Телефон", tablet: "Планшет", desktop: "Компьютер" };

/** Клиенты площадки по `tgWebAppPlatform`; неизвестный показывается как есть. */
const CLIENT_LABELS: Record<string, string> = {
  android: "TG Android",
  android_x: "TG Android X",
  ios: "TG iOS",
  tdesktop: "TG Desktop",
  macos: "TG macOS",
  weba: "TG Web A",
  webk: "TG Web K",
  web: "TG Web",
  max: "MAX",
  vk: "VK",
  unknown: "Вне площадки",
};

export function osLabel(os: string): string {
  return OS_LABELS[os] ?? os;
}

export function formFactorLabel(formFactor: string): string {
  return FORM_FACTOR_LABELS[formFactor] ?? formFactor;
}

export function clientLabel(client: string): string {
  return CLIENT_LABELS[client] ?? client;
}

export function dayLabel(day: string): string {
  const [, month, date] = day.split("-").map(Number);
  return `${date ?? ""} ${MONTHS[(month ?? 1) - 1] ?? ""}`;
}

export function offsetLabel(offsetMin: number): string {
  const sign = offsetMin < 0 ? "−" : "+";
  const abs = Math.abs(offsetMin);
  const minutes = abs % 60;
  return `UTC${sign}${Math.floor(abs / 60)}${minutes === 0 ? "" : `:${String(minutes).padStart(2, "0")}`}`;
}

/** «4:05», «1:02:40» — как таймер забега в клиенте. */
export function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = String(sec % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

export function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

export function renderStatsSvg(summary: StatsSummary, offsetMin: number): string {
  const parts: string[] = [];
  let y = PAD;

  parts.push(text(PAD, y + 22, "РУБЕЖ · ЗАКРЫТЫЙ ПЛЕЙТЕСТ", { size: 22, fill: PALETTE.accent, weight: 700, spacing: 3 }));
  parts.push(text(PAD, y + 88, `Сводка за ${dayLabel(summary.day)}`, { size: 56, fill: PALETTE.text, weight: 700 }));
  parts.push(
    text(PAD, y + 132, `на ${summary.time} (${offsetLabel(offsetMin)}) · забегов всего ${summary.runsTotal}`, {
      size: 24,
      fill: PALETTE.muted,
    }),
  );
  y += 172;

  const tiles: { value: number; label: string; sub: string }[] = [
    { value: summary.players.seen, label: "Открыли игру", sub: `сегодня ${summary.players.seenToday}` },
    { value: summary.players.played, label: "Сыграли", sub: `сегодня ${summary.players.playedToday}` },
    { value: summary.installs, label: "Устройств", sub: "установок игры" },
    { value: summary.runsToday, label: "Забегов сегодня", sub: `всего ${summary.runsTotal}` },
  ];
  const tileGap = 16;
  const tileWidth = (INNER - tileGap * (tiles.length - 1)) / tiles.length;
  tiles.forEach((tile, index) => {
    const x = PAD + index * (tileWidth + tileGap);
    parts.push(rect(x, y, tileWidth, 152, { fill: PALETTE.surface, stroke: PALETTE.border, radius: 18 }));
    parts.push(text(x + 24, y + 70, String(tile.value), { size: 56, fill: PALETTE.text, weight: 700 }));
    parts.push(text(x + 24, y + 108, tile.label, { size: 22, fill: PALETTE.muted }));
    parts.push(text(x + 24, y + 136, tile.sub, { size: 19, fill: PALETTE.faint }));
  });
  y += 152 + 56;

  parts.push(sectionTitle(y, "Устройства"));
  y += 28;
  for (const [label, series, name] of [
    ["ОС", summary.byOs, osLabel],
    ["Тип", summary.byFormFactor, formFactorLabel],
    ["Клиент", summary.byClient, clientLabel],
  ] as const) {
    parts.push(stackedRow(y, label, series, name));
    y += 92;
  }
  y += 44;

  parts.push(sectionTitle(y, "Забеги по сложностям"));
  y += 32;
  parts.push(difficultyTable(y, summary));
  y += 44 + summary.difficulties.length * 58 + 40;

  const columnWidth = (INNER - 40) / 2;
  const listHeight = Math.max(summary.topWeapons.length, summary.topDeaths.length, 1) * 46;
  parts.push(sectionTitle(y, "Стартовое оружие", PAD));
  parts.push(sectionTitle(y, "Кто убивает чаще", PAD + columnWidth + 40));
  y += 28;
  parts.push(barList(PAD, y, columnWidth, summary.topWeapons, SERIES[1]));
  parts.push(barList(PAD + columnWidth + 40, y, columnWidth, summary.topDeaths, PALETTE.danger));
  y += listHeight + 40;

  parts.push(sectionTitle(y, `Стресс-тест · отчётов ${summary.stress.reports}`));
  y += 28;
  if (summary.stress.byOs.length === 0) {
    parts.push(text(PAD, y + 30, "Отчётов пока нет", { size: 22, fill: PALETTE.faint }));
    y += 50;
  } else {
    for (const entry of summary.stress.byOs.slice(0, 4)) {
      const verdicts = entry.verdicts.map((verdict) => `${verdict.key} ${verdict.count}`).join(" · ");
      parts.push(text(PAD, y + 30, osLabel(entry.os), { size: 24, fill: PALETTE.text, weight: 600 }));
      parts.push(
        text(PAD + 200, y + 30, `прогонов ${entry.reports} · пик объектов ≈${entry.avgPeak} · ${verdicts}`, {
          size: 22,
          fill: PALETTE.muted,
        }),
      );
      y += 44;
    }
  }
  y += 36;

  parts.push(text(PAD, y + 20, "Без имён и Telegram ID: только счётчики и доли", { size: 19, fill: PALETTE.faint }));
  const height = y + 20 + PAD;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">`,
    rect(0, 0, WIDTH, height, { fill: PALETTE.bg }),
    ...parts,
    "</svg>",
  ].join("\n");
}

export function renderStatsPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    font: { loadSystemFonts: true, defaultFontFamily: "Arial" },
    fitTo: { mode: "original" },
  });
  return resvg.render().asPng();
}

/**
 * Подпись к фото — та же сводка текстом. Telegram режет подпись на 1024
 * символах, поэтому здесь только главное.
 */
export function renderStatsCaption(summary: StatsSummary): string {
  const lines = [
    `Плейтест · ${dayLabel(summary.day)}, ${summary.time}`,
    `Открыли игру: ${summary.players.seen} (сегодня ${summary.players.seenToday}) · сыграли: ${summary.players.played} (сегодня ${summary.players.playedToday})`,
    `Устройств: ${summary.installs} · забегов сегодня ${summary.runsToday}, всего ${summary.runsTotal}`,
    `ОС: ${inline(summary.byOs, osLabel)}`,
    `Тип: ${inline(summary.byFormFactor, formFactorLabel)}`,
    ...summary.difficulties
      .filter((entry) => entry.runs > 0)
      .map(
        (entry) =>
          `${DIFFICULTY_LABELS[entry.id]}: ${entry.runs} забегов, в среднем ${formatDuration(entry.avgSurvivalSec)}, рекорд ${entry.bestSurvivalSec === null ? "—" : formatDuration(entry.bestSurvivalSec)}`,
      ),
  ];
  return lines.join("\n").slice(0, 1024);
}

function inline(series: Share[], name: (key: string) => string): string {
  return series.length === 0 ? "нет данных" : series.map((entry) => `${name(entry.key)} ${entry.count}`).join(", ");
}

function sectionTitle(y: number, title: string, x = PAD): string {
  return text(x, y, title, { size: 30, fill: PALETTE.text, weight: 700 });
}

function stackedRow(y: number, label: string, series: Share[], name: (key: string) => string): string {
  const labelWidth = 150;
  const barX = PAD + labelWidth;
  const barWidth = INNER - labelWidth;
  const parts = [text(PAD, y + 28, label, { size: 24, fill: PALETTE.muted })];
  parts.push(rect(barX, y + 8, barWidth, 28, { fill: PALETTE.raised, radius: 14 }));
  if (series.length === 0) {
    parts.push(text(barX, y + 70, "нет данных", { size: 20, fill: PALETTE.faint }));
    return parts.join("\n");
  }

  // Доли внутри скруглённой полосы: клип вместо скругления каждой доли,
  // иначе стык соседних долей получает зазоры.
  const clipId = `clip-${Math.round(y)}`;
  parts.push(`<clipPath id="${clipId}"><rect x="${barX}" y="${y + 8}" width="${barWidth}" height="28" rx="14"/></clipPath>`);
  let x = barX;
  const segments: string[] = [];
  series.forEach((entry, index) => {
    const width = entry.share * barWidth;
    segments.push(rect(x, y + 8, width + 0.5, 28, { fill: SERIES[index % SERIES.length] ?? PALETTE.muted }));
    x += width;
  });
  parts.push(`<g clip-path="url(#${clipId})">${segments.join("")}</g>`);

  let legendX = barX;
  for (const [index, entry] of series.entries()) {
    const caption = `${name(entry.key)} ${entry.count} · ${percent(entry.share)}`;
    const width = 22 + estimateWidth(caption, 20);
    // Легенда в одну строку: что не влезло, видно по полосе и в подписи к фото.
    if (legendX + width > WIDTH - PAD) break;
    parts.push(`<circle cx="${legendX + 7}" cy="${y + 63}" r="7" fill="${SERIES[index % SERIES.length] ?? PALETTE.muted}"/>`);
    parts.push(text(legendX + 22, y + 70, caption, { size: 20, fill: PALETTE.muted }));
    legendX += width + 26;
  }
  return parts.join("\n");
}

function difficultyTable(y: number, summary: StatsSummary): string {
  // Правый край каждой числовой колонки: числа выравниваются по разрядам.
  const columns = [
    { title: "Сложность", x: PAD, anchor: "start" },
    { title: "Забегов", x: 390, anchor: "end" },
    { title: "Среднее", x: 530, anchor: "end" },
    { title: "Типично", x: 700, anchor: "end" },
    { title: "Уровень", x: 810, anchor: "end" },
    { title: "Сдались", x: 920, anchor: "end" },
    { title: "Рекорд", x: WIDTH - PAD, anchor: "end" },
  ] as const;
  const parts = columns.map((column) =>
    text(column.x, y + 20, column.title, { size: 20, fill: PALETTE.faint, anchor: column.anchor }),
  );
  summary.difficulties.forEach((entry, index) => {
    const rowY = y + 44 + index * 58;
    parts.push(rect(PAD - 16, rowY, INNER + 32, 50, { fill: index % 2 === 0 ? PALETTE.surface : PALETTE.bg, radius: 12 }));
    const empty = entry.runs === 0;
    const cells = [
      DIFFICULTY_LABELS[entry.id],
      String(entry.runs),
      empty ? "—" : formatDuration(entry.avgSurvivalSec),
      entry.medianRange ?? "—",
      empty ? "—" : entry.avgLevel.toFixed(1),
      empty ? "—" : percent(entry.abandonShare),
      entry.bestSurvivalSec === null ? "—" : formatDuration(entry.bestSurvivalSec),
    ];
    cells.forEach((cell, cellIndex) => {
      const column = columns[cellIndex];
      if (column === undefined) return;
      parts.push(
        text(column.x, rowY + 34, cell, {
          size: 24,
          fill: cellIndex === 0 ? PALETTE.text : empty ? PALETTE.faint : PALETTE.text,
          weight: cellIndex === 0 || cellIndex === 6 ? 600 : 400,
          anchor: column.anchor,
        }),
      );
    });
  });
  return parts.join("\n");
}

function barList(x: number, y: number, width: number, series: Share[], color: string): string {
  if (series.length === 0) return text(x, y + 30, "нет данных", { size: 22, fill: PALETTE.faint });
  const max = series[0]?.count ?? 1;
  const labelWidth = 190;
  const barWidth = width - labelWidth - 70;
  return series
    .map((entry, index) => {
      const rowY = y + index * 46;
      return [
        text(x, rowY + 30, entry.key, { size: 22, fill: PALETTE.text }),
        rect(x + labelWidth, rowY + 14, barWidth, 20, { fill: PALETTE.raised, radius: 10 }),
        rect(x + labelWidth, rowY + 14, Math.max(20, (entry.count / max) * barWidth), 20, { fill: color, radius: 10 }),
        text(x + width, rowY + 31, String(entry.count), { size: 22, fill: PALETTE.muted, anchor: "end" }),
      ].join("\n");
    })
    .join("\n");
}

/**
 * Ширина подписи без измерения шрифта: у resvg нет метрик до отрисовки.
 * Средняя ширина знака ≈ 0,55 кегля — с запасом для кириллицы.
 */
function estimateWidth(value: string, size: number): number {
  return value.length * size * 0.55;
}

interface TextStyle {
  size: number;
  fill: string;
  weight?: number;
  spacing?: number;
  anchor?: "start" | "middle" | "end";
}

function text(x: number, y: number, value: string, style: TextStyle): string {
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

function rect(x: number, y: number, width: number, height: number, style: { fill: string; stroke?: string; radius?: number }): string {
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

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Ключи оружия и причин смерти приходят от клиента — в разметку только экранированными. */
export function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
