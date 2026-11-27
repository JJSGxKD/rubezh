import { cardCacheKey } from "../../common/card/card-cache.js";
import { SCENE_HEIGHT, SCENE_PAD, SCENE_WIDTH, sceneLayers } from "../../common/card/scene.js";
import { estimateWidth, PALETTE, rect, renderPng, svgDocument, text, wrapWords } from "../../common/card/svg.js";
import { WELCOME_TEXTS, type WelcomeLanguage } from "./welcome-texts.js";

/**
 * Карточка приветствия по `/start`: имя, язык и прогресс игрока.
 *
 * Одинаковые входные данные — одинаковая картинка, поэтому она рисуется один
 * раз: ключ кэша — хэш всего, что на ней видно, плюс версия шаблона. Смена
 * шаблона — смена `CARD_VERSION`, иначе старые картинки отдавались бы из кэша.
 * Сменой версии сбрасываются и картинки, нарисованные без шрифта: их
 * `file_id` Telegram отдаёт так же охотно, как хорошие.
 *
 * Мир, облик и знак — общая сцена картинок бота (`common/card/scene.ts`), а
 * здесь только колонка приветствия; заголовки и числа — шрифтом игры.
 */
export const CARD_VERSION = 7;

const WIDTH = SCENE_WIDTH;
const HEIGHT = SCENE_HEIGHT;
/** Левое поле — как у сцены; вертикальные отступы колонки считаются от `TOP`. */
const LEFT = SCENE_PAD;
const TOP = 72;
const NAME_MAX = 18;

export interface WelcomeProgress {
  /** лучший забег в рейтинге единой сложности; `null` — рекорда нет */
  best: { points: number; survivalSec: number; rank: number; total: number } | null;
  runs: number;
}

export interface WelcomeCard {
  language: WelcomeLanguage;
  /** уже очищенное имя — см. `displayName` */
  name: string;
  progress: WelcomeProgress;
}

/**
 * Имя для картинки: буквы, цифры, пробел и знаки из имён. Эмодзи и
 * служебные символы выбрасываются — у системных шрифтов контейнера для них
 * нет глифов, и на картинке остались бы пустые квадраты.
 */
export function displayName(firstName: string | undefined, language: WelcomeLanguage): string {
  const cleaned = (firstName ?? "")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N} .'’-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return WELCOME_TEXTS[language].fallbackName;
  return cleaned.length > NAME_MAX ? `${cleaned.slice(0, NAME_MAX - 1).trimEnd()}…` : cleaned;
}

/** Число с разрядами через неразрывный пробел: «2 340». */
function formatNumber(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
}

/** Ключ кэша: имени в открытом виде в Redis нет — только хэш. */
export function welcomeCacheKey(card: WelcomeCard): string {
  const best = card.progress.best;
  return cardCacheKey(CARD_VERSION, [
    "welcome",
    card.language,
    card.name,
    card.progress.runs,
    // Время — с тем же округлением, что на картинке: иначе 7:42,4 и 7:42,6
    // дали бы две копии одной карточки.
    best === null ? null : [best.points, Math.round(best.survivalSec), best.rank, best.total],
  ]);
}

/** Колонка текста слева: правый край — до облика, который стоит справа от x 830. */
const COLUMN = 760;

export function renderWelcomeSvg(card: WelcomeCard): string {
  const texts = WELCOME_TEXTS[card.language];
  // Мир игры, хранитель перед частоколом и знак — общая сцена: картинка в чате
  // узнаётся по ним. Звёзды правее колонки: над текстом они ложились бы на буквы.
  const parts: string[] = sceneLayers("keeper", { starsFrom: (LEFT + COLUMN) / WIDTH });

  const greeting = texts.greeting(card.name);
  const greetingSize = estimateWidth(greeting, 64, true) > COLUMN ? 48 : 64;
  parts.push(text(LEFT, TOP + 140, greeting, { size: greetingSize, fill: PALETTE.text, heading: true }));

  const best = card.progress.best;
  if (best === null) {
    const lead = wrapWords(texts.newcomerLead, 26, COLUMN).slice(0, 2);
    lead.forEach((line, index) => parts.push(text(LEFT, TOP + 192 + index * 34, line, { size: 26, fill: PALETTE.muted })));
    texts.newcomerPoints.forEach((point, index) => {
      const y = TOP + 282 + index * 54;
      parts.push(rect(LEFT, y - 26, 34, 34, { fill: PALETTE.raised, stroke: PALETTE.border, radius: 10 }));
      parts.push(text(LEFT + 17, y - 1, String(index + 1), { size: 22, fill: PALETTE.accent, heading: true, anchor: "middle" }));
      parts.push(text(LEFT + 56, y, point, { size: estimateWidth(point, 28) > COLUMN - 56 ? 24 : 28, fill: PALETTE.text }));
    });
    const call = wrapWords(texts.newcomerCall, 28, COLUMN, true);
    call.forEach((line, index) => parts.push(text(LEFT, HEIGHT - TOP - 46 - (call.length - 1 - index) * 36, line, { size: 28, fill: PALETTE.elite, heading: true })));
  } else {
    const panelY = TOP + 176;
    parts.push(rect(LEFT, panelY, COLUMN, 236, { fill: PALETTE.surface, stroke: PALETTE.border, radius: 24 }));
    const score = formatNumber(best.points);
    // Справа от очков стоит место, поэтому длинное число уменьшается, а не наезжает на него.
    const scoreSize = estimateWidth(score, 120, true) > COLUMN * 0.6 ? 96 : 120;
    parts.push(text(LEFT + 36, panelY + 140, score, { size: scoreSize, fill: PALETTE.accent, heading: true }));
    parts.push(text(LEFT + 40, panelY + 196, texts.pointsLabel(best.survivalSec), { size: 28, fill: PALETTE.muted, spacing: 1 }));

    const right = LEFT + COLUMN - 32;
    const rank = texts.rank(best.rank, best.total);
    const chipWidth = estimateWidth(rank, 36) + 52;
    parts.push(rect(right - chipWidth, panelY + 64, chipWidth, 64, { fill: PALETTE.raised, stroke: PALETTE.border, radius: 32 }));
    parts.push(text(right - chipWidth / 2, panelY + 108, rank, { size: 36, fill: PALETTE.text, heading: true, anchor: "middle" }));
    parts.push(text(right, panelY + 186, texts.runs(card.progress.runs), { size: 28, fill: PALETTE.muted, anchor: "end" }));
    const call = wrapWords(texts.veteranCall, 32, COLUMN, true);
    call.forEach((line, index) => parts.push(text(LEFT, HEIGHT - TOP - 46 - (call.length - 1 - index) * 40, line, { size: 32, fill: PALETTE.elite, heading: true })));
  }

  return svgDocument(WIDTH, HEIGHT, parts);
}

export function renderWelcomePng(card: WelcomeCard): Buffer {
  return renderPng(renderWelcomeSvg(card));
}
