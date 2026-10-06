import { createHash } from "node:crypto";
import { formatDuration } from "../../common/card/labels.js";
import { estimateWidth, PALETTE, rect, renderPng, svgDocument, text } from "../../common/card/svg.js";
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
export const CARD_VERSION = 3;

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

export function renderWelcomeSvg(card: WelcomeCard): string {
  const texts = WELCOME_TEXTS[card.language];
  const parts: string[] = [
    // Мягкое свечение акцентом за карточкой: без него тёмный фон в чате
    // сливается с тёмной темой Telegram.
    `<defs><radialGradient id="glow" cx="85%" cy="15%" r="70%"><stop offset="0%" stop-color="${PALETTE.accent}" stop-opacity="0.22"/><stop offset="100%" stop-color="${PALETTE.bg}" stop-opacity="0"/></radialGradient></defs>`,
    rect(0, 0, WIDTH, HEIGHT, { fill: "url(#glow)" }),
    rect(PAD, PAD - 8, 10, 44, { fill: PALETTE.accent, radius: 3 }),
    text(PAD + 26, PAD + 26, texts.brand, { size: 30, fill: PALETTE.accent, weight: 800, spacing: 6 }),
  ];

  const greeting = texts.greeting(card.name);
  const greetingSize = estimateWidth(greeting, 72) > WIDTH - PAD * 2 ? 56 : 72;
  parts.push(text(PAD, PAD + 140, greeting, { size: greetingSize, fill: PALETTE.text, weight: 800 }));

  const best = card.progress.best;
  if (best === null) {
    parts.push(text(PAD, PAD + 200, texts.newcomerLead, { size: 30, fill: PALETTE.muted }));
    texts.newcomerPoints.forEach((point, index) => {
      const y = PAD + 290 + index * 64;
      parts.push(rect(PAD, y - 26, 34, 34, { fill: PALETTE.raised, stroke: PALETTE.border, radius: 10 }));
      parts.push(text(PAD + 17, y - 1, String(index + 1), { size: 22, fill: PALETTE.accent, weight: 700, anchor: "middle" }));
      parts.push(text(PAD + 56, y, point, { size: 30, fill: PALETTE.text }));
    });
    parts.push(text(PAD, HEIGHT - PAD, texts.newcomerCall, { size: 28, fill: PALETTE.faint }));
  } else {
    const panelY = PAD + 190;
    parts.push(rect(PAD, panelY, WIDTH - PAD * 2, 250, { fill: PALETTE.surface, stroke: PALETTE.border, radius: 28 }));
    parts.push(text(PAD + 44, panelY + 150, formatDuration(best.survivalSec), { size: 132, fill: PALETTE.accent, weight: 800 }));
    parts.push(text(PAD + 48, panelY + 208, texts.recordLabel(best.difficulty), { size: 30, fill: PALETTE.muted, spacing: 1 }));

    const right = WIDTH - PAD - 44;
    const rank = texts.rank(best.rank, best.total);
    const chipWidth = estimateWidth(rank, 40) + 56;
    parts.push(rect(right - chipWidth, panelY + 70, chipWidth, 72, { fill: PALETTE.raised, stroke: PALETTE.border, radius: 36 }));
    parts.push(text(right - chipWidth / 2, panelY + 118, rank, { size: 40, fill: PALETTE.text, weight: 700, anchor: "middle" }));
    parts.push(text(right, panelY + 196, texts.runs(card.progress.runs), { size: 30, fill: PALETTE.muted, anchor: "end" }));
    parts.push(text(PAD, HEIGHT - PAD, texts.veteranCall, { size: 34, fill: PALETTE.text, weight: 700 }));
  }

  return svgDocument(WIDTH, HEIGHT, parts);
}

export function renderWelcomePng(card: WelcomeCard): Buffer {
  return renderPng(renderWelcomeSvg(card));
}
