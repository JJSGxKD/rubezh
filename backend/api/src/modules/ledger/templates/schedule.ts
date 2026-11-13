import { formatMinor } from "@bh/ledger";
import { currencySpec } from "../ledger-currencies.js";
import type { OperationInputOf } from "../operations/operation-input.js";

/**
 * Шаблоны повторяющихся расходов: правила без базы (docs/37-accounting.md §8, Р220, tasks/T-0463) — наступил ли
 * шаблон в периоде, какой черновик расхода из него выходит и какие периоды можно создавать. Таблицы и порядок
 * действий — `templates.repository.ts` и `templates.service.ts`.
 */

export const TEMPLATE_SCHEDULES = ["monthly", "yearly"] as const;
export type TemplateSchedule = (typeof TEMPLATE_SCHEDULES)[number];

/** Что нужно знать о шаблоне, чтобы понять, наступил ли он. */
export interface ScheduledTemplate {
  schedule: TemplateSchedule;
  /** месяц года, 1…12: у годового шаблона обязателен, у месячного пуст */
  month: number | null;
}

/** Что нужно знать о шаблоне, чтобы собрать из него черновик: валюта — валюта места, в ней же сумма. */
export interface DraftableTemplate extends ScheduledTemplate {
  name: string;
  articleId: string;
  placeAccountId: string;
  /** обычная сумма в минимальных единицах валюты места */
  amount: bigint;
  currency: string;
}

const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])$/u;

const MONTH_TITLES = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"] as const;

/** «ГГГГ-ММ» → число месяцев от нулевого года: период сравнивается и сдвигается как число. */
function monthNumber(period: string): number | null {
  const match = PERIOD.exec(period);
  if (match === null) return null;
  return Number(match[1]) * 12 + Number(match[2]) - 1;
}

/** Месяц периода, 1…12; не «ГГГГ-ММ» — исключение: сюда доходит только проверенный период. */
function monthOf(period: string): number {
  const match = PERIOD.exec(period);
  if (match === null) throw new RangeError(`Период «${period}» не в виде ГГГГ-ММ`);
  return Number(match[2]);
}

/** Месячный наступает всегда, годовой — в своём месяце года. */
export function isDue(template: ScheduledTemplate, period: string): boolean {
  if (template.schedule === "monthly") return true;
  return template.month !== null && template.month === monthOf(period);
}

/** «ноябрь 2026»: после «за» месяц остаётся в той же форме. */
export function monthTitle(period: string): string {
  const match = PERIOD.exec(period);
  if (match === null) throw new RangeError(`Период «${period}» не в виде ГГГГ-ММ`);
  return `${MONTH_TITLES[Number(match[2]) - 1] ?? ""} ${match[1] ?? ""}`;
}

export function firstDayOf(period: string): string {
  monthOf(period);
  return `${period}-01`;
}

/**
 * Дата события черновика: первое число периода, но не позже сегодняшнего дня по UTC. Учёт записывает случившееся
 * (`commonProblems`), поэтому расход за следующий месяц, внесённый заранее, датируется днём внесения.
 */
export function eventDate(period: string, now: Date): string {
  const first = firstDayOf(period);
  const today = now.toISOString().slice(0, 10);
  return first > today ? today : first;
}

/** Вход операции «расход» по шаблону на период: человек сверит сумму с фактом и проведёт. */
export function draftInput(template: DraftableTemplate, period: string): OperationInputOf<"expense"> {
  return {
    kind: "expense",
    from: template.placeAccountId,
    article: template.articleId,
    amount: formatMinor(template.amount, currencySpec(template.currency)),
    at: firstDayOf(period),
    note: `${template.name} за ${monthTitle(period)}`,
  };
}

/**
 * Какие периоды можно создавать: от прошлого месяца до следующего включительно. Дальше назад — это уже исправление
 * учёта задним числом (его делают операциями), дальше вперёд — планирование, которого шаблон не обещает.
 * `null` — период подходит, иначе — что не так, по-русски.
 */
export function periodProblem(period: string, now: Date): string | null {
  const target = monthNumber(period);
  if (target === null) return "Период нужен в виде ГГГГ-ММ, например 2026-11";
  const current = now.getUTCFullYear() * 12 + now.getUTCMonth();
  if (target < current - 1) return "Расходы месяца создаются не раньше прошлого месяца";
  if (target > current + 1) return "Расходы месяца создаются не позже следующего месяца";
  return null;
}
