import { createHash } from "node:crypto";
import { formatDuration } from "../../common/card/labels.js";
import { HERO_PORTRAITS, PORTRAIT_RATIO, WORDMARK_RATIO, WORDMARK_SVG } from "../../common/card/brand-art.js";
import { estimateWidth, PALETTE, rect, renderPng, svgDocument, svgImage, text, twilightBackdrop, wrapWords } from "../../common/card/svg.js";
import { WELCOME_TEXTS, type Difficulty, type WelcomeLanguage } from "./welcome-texts.js";

/**
 * Карточка приветствия по `/start`: имя, язык и прогресс игрока.
 *
 * Одинаковые входные данные — одинаковая картинка, поэтому она рисуется один
 * раз: ключ кэша — хэш всего, что на ней видно, плюс версия шаблона. Смена
 * шаблона — смена `CARD_VERSION`, иначе старые картинки отдавались бы из кэша.
 * Сменой версии сбрасываются и картинки, нарисованные без шрифта: их
 * `file_id` Telegram отдаёт так же охотно, как хорошие.
 */
export const CARD_VERSION = 4;

const WIDTH = 1200;
const HEIGHT = 675;
const PAD = 72;
const NAME_MAX = 18;

export interface WelcomeProgress {
  /** лучший забег на самой сложной сложности, где он есть; `null` — забегов нет */
  best: { difficulty: Difficulty; survivalSec: number; rank: number; total: number } | null;
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

/** Ключ кэша: имени в открытом виде в Redis нет — только хэш. */
export function welcomeCacheKey(card: WelcomeCard): string {
  const best = card.progress.best;
  const payload = JSON.stringify([
    CARD_VERSION,
    card.language,
    card.name,
    card.progress.runs,
    // Время — с тем же округлением, что на картинке: иначе 7:42,4 и 7:42,6
    // дали бы две копии одной карточки.
    best === null ? null : [best.difficulty, Math.round(best.survivalSec), best.rank, best.total],
  ]);
  return createHash("sha256").update(payload).digest("hex");
}

/** Герой справа и колонка текста слева: ширина колонки — то, что осталось от героя. */
const HERO_WIDTH = 300;
const COLUMN = WIDTH - PAD * 2 - HERO_WIDTH - 24;

export function renderWelcomeSvg(card: WelcomeCard): string {
  const texts = WELCOME_TEXTS[card.language];
  // Мир игры: небо, жар очага, частокол — и хранитель перед частоколом. Знак
  // вместо подписи «РУБЕЖ»: картинка в чате узнаётся по нему.
  const heroHeight = HERO_WIDTH * PORTRAIT_RATIO;
  const parts: string[] = [
    ...twilightBackdrop(WIDTH, HEIGHT, { starsFrom: (PAD + COLUMN) / WIDTH }),
    svgImage(HERO_PORTRAITS.keeper ?? "", WIDTH - PAD - HERO_WIDTH + 20, HEIGHT - heroHeight - 6, HERO_WIDTH, heroHeight),
    svgImage(WORDMARK_SVG, PAD - 12, PAD - 34, 290, 290 * WORDMARK_RATIO),
  ];

  const greeting = texts.greeting(card.name);
  const greetingSize = estimateWidth(greeting, 64, true) > COLUMN ? 48 : 64;
  parts.push(text(PAD, PAD + 140, greeting, { size: greetingSize, fill: PALETTE.text, weight: 800 }));

  const best = card.progress.best;
  if (best === null) {
    const lead = wrapWords(texts.newcomerLead, 26, COLUMN).slice(0, 2);
    lead.forEach((line, index) => parts.push(text(PAD, PAD + 192 + index * 34, line, { size: 26, fill: PALETTE.muted })));
    texts.newcomerPoints.forEach((point, index) => {
      const y = PAD + 282 + index * 54;
      parts.push(rect(PAD, y - 26, 34, 34, { fill: PALETTE.raised, stroke: PALETTE.border, radius: 10 }));
      parts.push(text(PAD + 17, y - 1, String(index + 1), { size: 22, fill: PALETTE.accent, weight: 700, anchor: "middle" }));
      parts.push(text(PAD + 56, y, point, { size: estimateWidth(point, 28) > COLUMN - 56 ? 24 : 28, fill: PALETTE.text }));
    });
    const call = wrapWords(texts.newcomerCall, 28, COLUMN, true);
    call.forEach((line, index) => parts.push(text(PAD, HEIGHT - PAD - 46 - (call.length - 1 - index) * 36, line, { size: 28, fill: PALETTE.elite, weight: 700 })));
  } else {
    const panelY = PAD + 176;
    parts.push(rect(PAD, panelY, COLUMN, 236, { fill: PALETTE.surface, stroke: PALETTE.border, radius: 24 }));
    parts.push(text(PAD + 36, panelY + 140, formatDuration(best.survivalSec), { size: 120, fill: PALETTE.accent, weight: 800 }));
    parts.push(text(PAD + 40, panelY + 196, texts.recordLabel(best.difficulty), { size: 28, fill: PALETTE.muted, spacing: 1 }));

    const right = PAD + COLUMN - 32;
    const rank = texts.rank(best.rank, best.total);
    const chipWidth = estimateWidth(rank, 36) + 52;
    parts.push(rect(right - chipWidth, panelY + 64, chipWidth, 64, { fill: PALETTE.raised, stroke: PALETTE.border, radius: 32 }));
    parts.push(text(right - chipWidth / 2, panelY + 108, rank, { size: 36, fill: PALETTE.text, weight: 700, anchor: "middle" }));
    parts.push(text(right, panelY + 186, texts.runs(card.progress.runs), { size: 28, fill: PALETTE.muted, anchor: "end" }));
    const call = wrapWords(texts.veteranCall, 32, COLUMN, true);
    call.forEach((line, index) => parts.push(text(PAD, HEIGHT - PAD - 46 - (call.length - 1 - index) * 40, line, { size: 32, fill: PALETTE.elite, weight: 700 })));
  }

  return svgDocument(WIDTH, HEIGHT, parts);
}

export function renderWelcomePng(card: WelcomeCard): Buffer {
  return renderPng(renderWelcomeSvg(card));
}
