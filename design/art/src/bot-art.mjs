/**
 * Бренд для картинок бота (design/art/direction-v2.md §7.5): словесный знак,
 * значок приложения и портреты обликов — строками в модуль бэкенда. Бэкенд не
 * читает `design/art` во время работы, поэтому рисунок попадает к нему
 * сгенерированным файлом, как знак — в оболочку (`logo.mjs`).
 *
 * Сначала `logo.mjs` и `portraits.mjs`, потом:
 *   node design/art/src/bot-art.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HERO_SKINS } from "./hero.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "../out");
const TARGET = join(HERE, "../../../backend/api/src/common/card/brand-art.ts");

const read = (path) => readFileSync(join(OUT, path), "utf8").trim();
const literal = (svg) => JSON.stringify(svg);

const portraits = HERO_SKINS.map((skin) => `  ${JSON.stringify(skin.id)}: ${literal(read(`card-hero-${skin.id}.svg`))},`);

const source = `// Сгенерировано design/art/src/bot-art.mjs — правится там, а не здесь.

/**
 * Рисунок бренда для картинок бота: словесный знак «РУБЕЖ», значок
 * приложения (квадрат без скругления — Telegram сам обрезает фото кругом) и
 * портреты обликов героя. Строки SVG вставляются в карточки картинкой
 * (\`svgImage\` в \`svg.ts\`), поэтому их градиенты и фильтры не спорят с
 * разметкой карточки.
 */
export const WORDMARK_SVG = ${literal(read("brand/wordmark.svg"))};

/** Пропорции словесного знака: высота к ширине. */
export const WORDMARK_RATIO = ${(143 / 454).toFixed(4)};

export const APP_ICON_SVG = ${literal(read("brand/app-icon-square.svg"))};

/** Портрет облика по id (\`HERO_SKINS\` в hero.mjs), все в одной рамке \`ARCHETYPE_BOX\`. */
export const HERO_PORTRAITS: Readonly<Record<string, string>> = {
${portraits.join("\n")}
};

/** Пропорции портрета: высота к ширине. */
export const PORTRAIT_RATIO = ${(94 / 62).toFixed(4)};
`;

writeFileSync(TARGET, source);
console.log(`${TARGET} · ${String(Buffer.byteLength(source))} Б`);
