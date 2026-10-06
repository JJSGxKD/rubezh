import { ZodError } from "zod";
import { ValidationError } from "../../common/domain-error.js";

/** Разбор границы: ошибка схемы — 400 с русским текстом, остальное — наверх. Один на все контроллеры панели. */
export function parse<T>(read: () => T, message: string): T {
  try {
    return read();
  } catch (error: unknown) {
    if (error instanceof ZodError) throw new ValidationError(message);
    throw error;
  }
}

const DAY_MS = 86_400_000;
/** Дольше года воронку и выгрузку не режут: такой запрос — просмотр всей базы. */
const MAX_PERIOD_DAYS = 366;
const DEFAULT_PERIOD_DAYS = 30;

export interface Period {
  from: Date;
  to: Date;
}

/**
 * Период отчёта: обе границы или их умолчания — последние тридцать дней до
 * сейчас. Границы в обратном порядке и период длиннее года — ошибка запроса.
 */
export function periodOf(query: { from?: Date | undefined; to?: Date | undefined }, now: Date): Period {
  const to = query.to ?? now;
  const from = query.from ?? new Date(to.getTime() - DEFAULT_PERIOD_DAYS * DAY_MS);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new ValidationError("Некорректные даты периода");
  if (from >= to) throw new ValidationError("Начало периода должно быть раньше конца");
  if (to.getTime() - from.getTime() > MAX_PERIOD_DAYS * DAY_MS) throw new ValidationError("Период не длиннее года");
  return { from, to };
}
