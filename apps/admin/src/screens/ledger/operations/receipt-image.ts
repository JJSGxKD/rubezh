import { IMAGE_PROFILES } from "../../../api/media";
import { sourceProblem, type Size } from "../../../ui/image-crop";

/**
 * Снимок чека операции (tasks/T-0462, T-0464): не квадрат — фотография или скриншот документа. Обрезки нет, только
 * сжатие: длинная сторона не больше профиля (1600 px), короткая не меньше 300 px, чтобы читались цифры.
 */
const { side: MAX_SIDE, minSide: MIN_SIDE } = IMAGE_PROFILES.finance_receipt;

/** Что не так с файлом, ещё не открытым; `null` — открывать. */
export function receiptFileProblem(file: { type: string; size: number }): string | null {
  return sourceProblem(file);
}

/** Что не так с открытой картинкой: короткая сторона меньше 300 px — цифры чека не прочесть. */
export function receiptSizeProblem(size: Size): string | null {
  if (Math.min(size.width, size.height) >= MIN_SIDE) return null;
  return `Снимок ${String(size.width)}×${String(size.height)}: короткая сторона меньше ${String(MIN_SIDE)} px — цифры чека не прочесть. Возьмите снимок покрупнее`;
}

/** Размер результата: длинная сторона не больше 1600 px, пропорции целы, мелкое не растягивается; `shrink` — доля поверх. */
export function receiptTarget(size: Size, shrink = 1): Size {
  const long = Math.max(size.width, size.height);
  const scale = Math.min(1, MAX_SIDE / long) * shrink;
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

/** Доли, на которые сжимаем размер, если файл тяжелее предела даже при худшем качестве: чек — текст, ему хватит. */
export const RECEIPT_SHRINK_STEPS = [1, 0.8, 0.65] as const;

/** Короткая сторона после сжатия не должна опуститься ниже минимума профиля. */
export function receiptShrinkAllowed(size: Size, shrink: number): boolean {
  const target = receiptTarget(size, shrink);
  return Math.min(target.width, target.height) >= MIN_SIDE;
}
