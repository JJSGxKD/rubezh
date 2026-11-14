import { docProblems, type PromoDoc } from "@bh/promo-kit";

/**
 * Предупреждения редактора перед выгрузкой: правила модели (`docProblems`)
 * плюс то, что знает только редактор, — читается ли QR. Выгрузку они не
 * запрещают (tasks/T-0274): решает человек.
 */

/** Контраст модулей QR с фоном, ниже которого камера телефона читает с экрана плохо. */
export const MIN_QR_CONTRAST = 4;

function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Отношение яркостей по WCAG, от 1 до 21. */
export function contrastRatio(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function editorProblems(doc: PromoDoc): string[] {
  const problems = docProblems(doc);
  for (const layer of doc.layers) {
    if (layer.type !== "qr" || layer.hidden === true) continue;
    if (luminance(layer.fg) >= luminance(layer.bg)) {
      problems.push(`QR «${layer.id}»: модули светлее фона — многие сканеры читают только тёмный код на светлом`);
    } else if (contrastRatio(layer.fg, layer.bg) < MIN_QR_CONTRAST) {
      problems.push(`QR «${layer.id}»: слабый контраст модулей с фоном — код может не прочитаться`);
    }
  }
  return problems;
}
