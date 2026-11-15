import { HERO_PORTRAITS, PORTRAIT_RATIO, WORDMARK_RATIO, WORDMARK_SVG } from "./brand-art.js";
import { estimateWidth, PALETTE, round, svgDocument, svgImage, text, twilightBackdrop, wrapWords } from "./svg.js";

/**
 * Общая сцена картинок бота (docs/35-stage4-plan.md Р156, design/art/meta-v2.md
 * §3.4): мир «Сумеречного рубежа», облик игрока и словесный знак, поверх —
 * заголовок шрифтом игры, до трёх строк текста и необязательная плашка.
 * Картинки конкретных сообщений рисуют на ней свои блоки, не повторяя мир.
 *
 * Облик на картинке — облик того, о ком сообщение. Облика нет в рисунках
 * (устарел id, игрок без выбора) — хранитель: он есть у всех.
 */

export const SCENE_WIDTH = 1200;
export const SCENE_HEIGHT = 675;

/** Поля сцены: слева и справа 44, сверху 28; ниже 587 частокол — текст туда не заходит. */
export const SCENE_PAD = 44;
const TEXT_TOP = 140;
const TEXT_WIDTH = 680;

/** Облик по умолчанию: хранитель есть у каждого игрока. */
const DEFAULT_SKIN = "keeper";

/** Тона акцента — имена токенов `PALETTE`, а не произвольные цвета. */
export type SceneTone = "text" | "muted" | "accent" | "secondary" | "elite" | "danger" | "success";

export interface SceneBadge {
  /** «★ Новый рекорд» — короткая подпись в плашке */
  text: string;
  tone?: SceneTone;
}

export interface HeroSceneInput {
  /** id облика из `HERO_PORTRAITS`; нет или незнакомый — хранитель */
  skin?: string | null;
  /** заголовок, не больше двух строк */
  title: string;
  /** описание под заголовком, не больше трёх строк */
  text?: string;
  /** плашка под текстом: число, рекорд, подарок */
  badge?: SceneBadge;
  /** цвет заголовка; по умолчанию светлый текст */
  tone?: SceneTone;
}

/** Где стоят знак и облик. Числа по умолчанию — раскладка мета-документа; приветствие подстраивает их под свою колонку. */
export interface SceneLayout {
  wordmark?: { x: number; y: number; width: number };
  hero?: {
    /** высота облика */
    height: number;
    /** отступ правого края облика от края картинки */
    right: number;
    /** отступ ног от нижнего края */
    bottom: number;
  };
  /** доля ширины, правее которой рисуются звёзды: над колонкой текста они ложились бы на буквы */
  starsFrom?: number;
}

const DEFAULT_LAYOUT = {
  wordmark: { x: SCENE_PAD, y: 28, width: 260 },
  hero: { height: 500, right: 40, bottom: 8 },
  starsFrom: (SCENE_PAD + TEXT_WIDTH) / SCENE_WIDTH,
} as const;

const TITLE_SIZE = 52;
const TEXT_SIZE = 28;
const BADGE_SIZE = 26;

export function toneColor(tone: SceneTone): string {
  return PALETTE[tone];
}

/** Портрет облика; незнакомый id — в том числе служебное имя объекта — это хранитель. */
export function portraitOf(skin: string | null | undefined): string {
  const known = skin !== null && skin !== undefined && Object.hasOwn(HERO_PORTRAITS, skin) ? HERO_PORTRAITS[skin] : undefined;
  return known ?? HERO_PORTRAITS[DEFAULT_SKIN] ?? "";
}

/**
 * Слои мира: небо, жар очага, частокол, облик со своей тенью и словесный знак.
 * Приветствие и картинки сообщений берут их отсюда, чтобы мир не расходился.
 */
export function sceneLayers(skin: string | null | undefined, layout: SceneLayout = {}): string[] {
  const wordmark = layout.wordmark ?? DEFAULT_LAYOUT.wordmark;
  const hero = layout.hero ?? DEFAULT_LAYOUT.hero;
  const heroWidth = hero.height / PORTRAIT_RATIO;
  return [
    ...twilightBackdrop(SCENE_WIDTH, SCENE_HEIGHT, { starsFrom: layout.starsFrom ?? DEFAULT_LAYOUT.starsFrom }),
    // Тень вниз на 8 px, чёрная на две трети: облик стоит на частоколе, а не висит над ним.
    `<defs><filter id="heroShadow" x="-25%" y="-10%" width="150%" height="130%"><feDropShadow dx="0" dy="8" stdDeviation="6" flood-color="#000000" flood-opacity="0.66"/></filter></defs>`,
    `<g filter="url(#heroShadow)">${svgImage(portraitOf(skin), SCENE_WIDTH - hero.right - heroWidth, SCENE_HEIGHT - hero.bottom - hero.height, heroWidth, hero.height)}</g>`,
    svgImage(WORDMARK_SVG, wordmark.x, wordmark.y, wordmark.width, wordmark.width * WORDMARK_RATIO),
  ];
}

/**
 * Не больше `max` строк: лишнее обрезается многоточием, а не уходит за край.
 * Слово длиннее строки (имя без пробелов) тоже укорачивается — иначе оно
 * наехало бы на облик.
 */
export function clampLines(lines: readonly string[], max: number, size: number, maxWidth: number, bold = false): string[] {
  const kept = lines.slice(0, max);
  const cut = lines.length > max;
  return kept.map((line, index) => {
    const needsMark = cut && index === kept.length - 1;
    if (!needsMark && estimateWidth(line, size, bold) <= maxWidth) return line;
    let shortened = needsMark ? line.replace(/[\s.,;:!?…-]+$/u, "") : line;
    while (shortened.length > 1 && estimateWidth(`${shortened}…`, size, bold) > maxWidth) shortened = shortened.slice(0, -1).trimEnd();
    return `${shortened}…`;
  });
}

/** Плашка: поля 8 × 20, радиус до круга, контур и подпись одного тона. */
function badgePill(x: number, y: number, badge: SceneBadge): { svg: string; bottom: number } {
  const color = toneColor(badge.tone ?? "elite");
  const width = estimateWidth(badge.text, BADGE_SIZE, true) + 40;
  const height = BADGE_SIZE + 16;
  const svg = [
    `<rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${height}" rx="${height / 2}" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-opacity="0.6" stroke-width="2"/>`,
    text(x + 20, y + 8 + BADGE_SIZE * 0.85, badge.text, { size: BADGE_SIZE, fill: color, heading: true }),
  ].join("");
  return { svg, bottom: y + height };
}

/**
 * Сцена 1200×675 с заголовком: левая колонка — заголовок (до двух строк),
 * ниже текст (до трёх) и плашка, справа — облик.
 */
export function heroScene(input: HeroSceneInput): string {
  const parts = sceneLayers(input.skin);
  let top = TEXT_TOP;

  const titleLines = input.title === "" ? [] : clampLines(wrapWords(input.title, TITLE_SIZE, TEXT_WIDTH, true), 2, TITLE_SIZE, TEXT_WIDTH, true);
  const titleColor = toneColor(input.tone ?? "text");
  for (const line of titleLines) {
    parts.push(text(SCENE_PAD, top + TITLE_SIZE * 0.9, line, { size: TITLE_SIZE, fill: titleColor, heading: true }));
    top += TITLE_SIZE * 1.1;
  }
  if (titleLines.length > 0) top += 16;

  const bodyLines = input.text === undefined || input.text === "" ? [] : clampLines(wrapWords(input.text, TEXT_SIZE, TEXT_WIDTH), 3, TEXT_SIZE, TEXT_WIDTH);
  for (const line of bodyLines) {
    parts.push(text(SCENE_PAD, top + TEXT_SIZE * 0.9, line, { size: TEXT_SIZE, fill: PALETTE.muted }));
    top += TEXT_SIZE * 1.35;
  }

  if (input.badge !== undefined) {
    const pill = badgePill(SCENE_PAD, top + 28, input.badge);
    parts.push(pill.svg);
  }

  return svgDocument(SCENE_WIDTH, SCENE_HEIGHT, parts);
}
