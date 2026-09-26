import { createHash } from "node:crypto";
import { PALETTE, rect, svgDocument, text } from "../../common/card/svg.js";
import type { Difficulty } from "../runs/run-rules.js";

/**
 * Карточка результата забега для шеринга (docs/24-attribution-and-sharing.md
 * §7.4): SVG-шаблон, растеризуемый на сервере, 1200×630 — пропорция превью
 * ссылки в мессенджерах. Цвета — палитра карточек бота (`common/card/svg.ts`).
 *
 * Ключ кеша — хэш параметров вместе с версией шаблона: та же карточка второй
 * раз не рисуется, а правка шаблона сама выводит старые картинки из кеша.
 */

export const RUN_CARD = { width: 1200, height: 630, version: 1 } as const;

export interface RunCardParams {
  name: string;
  difficulty: Difficulty;
  /** целые секунды: дробь ничего не меняет на карточке, но дробила бы кеш */
  survivalSec: number;
  level: number;
  kills: number;
}

const DIFFICULTY_NAMES: Record<Difficulty, string> = { easy: "лёгкая", normal: "нормальная", hard: "сложная" };

/** Имя — чужой текст на нашей картинке: не длиннее строки. */
const NAME_MAX = 28;

export function runCardKey(params: RunCardParams): string {
  const canonical = JSON.stringify([RUN_CARD.version, params.name, params.difficulty, params.survivalSec, params.level, params.kills]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** «12:34», а с часа — «1:02:03»: так время забега показывает и игра. */
export function formatSurvival(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat("ru-RU").format(value).replace(/ /g, " ");
}

export function runCardSvg(params: RunCardParams): string {
  const { width, height } = RUN_CARD;
  const name = params.name.length > NAME_MAX ? `${params.name.slice(0, NAME_MAX - 1)}…` : params.name;
  const stats: [string, string][] = [
    ["уровень", String(params.level)],
    ["врагов", formatCount(params.kills)],
    ["сложность", DIFFICULTY_NAMES[params.difficulty]],
  ];
  const statWidth = 330;

  return svgDocument(width, height, [
    rect(0, 0, width, 12, { fill: PALETTE.accent }),
    text(72, 110, "РУБЕЖ", { size: 40, fill: PALETTE.accent, weight: 800, spacing: 6 }),
    text(width - 72, 110, name, { size: 34, fill: PALETTE.muted, weight: 600, anchor: "end" }),
    text(72, 230, "рекорд под натиском", { size: 36, fill: PALETTE.muted }),
    text(66, 390, formatSurvival(params.survivalSec), { size: 170, fill: PALETTE.text, weight: 800 }),
    ...stats.flatMap(([label, value], index) => {
      const x = 72 + index * (statWidth + 24);
      return [
        rect(x, 440, statWidth, 104, { fill: PALETTE.surface, stroke: PALETTE.border, radius: 16 }),
        text(x + 28, 482, label, { size: 26, fill: PALETTE.faint }),
        text(x + 28, 526, value, { size: 38, fill: PALETTE.text, weight: 700 }),
      ];
    }),
    text(width - 72, 600, "Сможешь дольше?", { size: 30, fill: PALETTE.accent, weight: 700, anchor: "end" }),
  ]);
}
