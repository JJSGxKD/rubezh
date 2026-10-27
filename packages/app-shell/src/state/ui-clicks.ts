import { currentScreen, useNavigation } from "./navigation";
import { track } from "./shell";

/**
 * Нажатия кнопок дизайн-системы (docs/35-stage4-plan.md Р141, tasks/T-0226):
 * событие `ui_clicked` с текущим экраном и устойчивым именем кнопки. Имя — по
 * смыслу действия (`buy`, `claim`, `share`), а не по тексту: подпись меняется,
 * а id должен оставаться прежним, иначе сравнение по неделям ломается. Текста
 * кнопки и личных данных в событии нет.
 */
const CONTROL_RE = /^[a-z0-9_-]{1,24}(\.[a-z0-9_-]{1,24})?$/;

/** Имя пункта вкладок или переключателя: «группа.пункт». */
export function groupControl(group: string, item: string): string {
  return `${group}.${item}`;
}

/** Нажатие с именем `control`; неверный формат — предупреждение и без события, разметка не должна ронять нажатие. */
export function trackClick(control: string): void {
  if (!CONTROL_RE.test(control)) {
    console.warn(`ui_clicked: имя «${control}» не подходит — латиница, цифры, «_» и «-», до 24 знаков, через одну точку`);
    return;
  }
  track("ui_clicked", { screen: currentScreen(useNavigation.getState().stack), control });
}

/** Нажатие пункта группы; у группы без `track` разметки нет и события тоже. */
export function trackGroupClick(group: string | undefined, item: string): void {
  if (group === undefined) return;
  trackClick(groupControl(group, item));
}
