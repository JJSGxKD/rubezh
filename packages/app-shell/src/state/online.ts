import type { ButtonBar } from "@bh/shared-types";
import { create } from "zustand";
import { formatDecimal, t } from "../i18n";

/**
 * Состояние и правила показа счётчика онлайна (Р107, docs/35-stage4-plan.md;
 * tasks/T-0148): сколько людей сейчас в игре и в забеге. Числа считает сервер и
 * сам же применяет пороги: ниже порога поле ответа — `null`, клиент ничего не
 * решает и не достраивает.
 *
 * Здесь — только то, что нужно плашке и «Играть» в первой загрузке. Пинг, его
 * схема и таймеры — в `online-ping.ts`, отдельным чанком: приложению хватает
 * чисел, пока пинг не поднялся.
 */

/** Числа плашки: то, что сервер отдал в последний удачный раз. */
export interface OnlineNumbers {
  online: number | null;
  inRun: number | null;
  todayPlayed: number | null;
}

export interface OnlineStore extends OnlineNumbers {
  /** сбоев подряд; удача обнуляет */
  failures: number;
}

export const NO_ONLINE_NUMBERS: OnlineStore = { online: null, inRun: null, todayPlayed: null, failures: 0 };

export const useOnline = create<OnlineStore>()(() => NO_ONLINE_NUMBERS);

/** Сброс между тестами: хранилище модульное. */
export function resetOnlineForTests(): void {
  useOnline.setState(NO_ONLINE_NUMBERS);
}

export type OnlineView = { kind: "now"; count: number } | { kind: "today"; count: number };

/**
 * Что показать на плашке. «Сейчас» — когда сервер дал онлайн; иначе «сегодня
 * играли», если оно есть; чисел нет — `null` (плашки нет, без заглушки «—»).
 * Ноль приравнен к отсутствию: «0 онлайн» выглядит как поломка, а не как сведения.
 */
export function onlineView(numbers: OnlineNumbers): OnlineView | null {
  if (numbers.online !== null && numbers.online > 0) return { kind: "now", count: numbers.online };
  if (numbers.todayPlayed !== null && numbers.todayPlayed > 0) return { kind: "today", count: numbers.todayPlayed };
  return null;
}

/** Подпись «N в забеге» под «Играть»; `null` — подписи нет. */
export function runCaption(numbers: Pick<OnlineNumbers, "inRun">): number | null {
  return numbers.inRun !== null && numbers.inRun > 0 ? numbers.inRun : null;
}

/**
 * Число для плашки: до тысячи как есть, дальше — «1,2 тыс.» до десяти тысяч и
 * «12 тыс.» после. Округление вниз: плашка не должна показывать больше, чем
 * есть. Своё, а не `formatCompact`: тот пишет «12,3К» и целые тысячи до десяти
 * тысяч, а плашка стоит в полосе кнопок, где место на счету.
 */
export function formatOnlineCount(value: number): string {
  const whole = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  if (whole < 1_000) return String(whole);
  const decimals = whole < 10_000 ? 1 : 0;
  const unit = 10 ** (3 - decimals);
  return t("online.thousands", { value: formatDecimal(Math.floor(whole / unit) / 10 ** decimals, decimals) });
}

export type OnlinePlacement = "bar" | "subline" | "header";

/**
 * Где стоит плашка. На ПК — в широкой шапке, сколько бы места ни было по
 * бокам; иначе в полосе кнопок площадки, если она есть (место, которое иначе
 * пустует), а без неё — строкой под шапкой.
 */
export function onlinePlacement(input: { wide: boolean; bar: ButtonBar | null }): OnlinePlacement {
  if (input.wide) return "header";
  return input.bar === null ? "subline" : "bar";
}
