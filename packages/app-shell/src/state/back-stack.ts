import { useEffect, useLayoutEffect, useRef } from "react";
import { create } from "zustand";

/**
 * Стек «Назад» (docs/35-stage4-plan.md WP45, Р81): кнопка «Назад» площадки и
 * Esc на ПК делают одно и то же — то, что нужно верхнему слою.
 *
 * Слои двух видов:
 * - **основа** — экран навигации: на экране раздела «Назад» возвращает на
 *   предыдущий, в забеге — ставит паузу (выйти из забега одним жестом
 *   нельзя);
 * - **слои поверх** — закрываемые модалки и листы: «Назад» закрывает
 *   верхний, а не уводит экран из-под него.
 *
 * Основа отдельно, а не первым слоем, потому что React вызывает эффекты
 * детей раньше родителя: модалка, открытая на старте, встала бы под экран.
 * Слои поверх идут по времени открытия, снятие из середины стек не ломает.
 */

export interface BackBase {
  action: (() => void) | null;
  /** Esc на ПК — то же действие; в забеге клавиши свои (`screens/run/run-keys.ts`) */
  keyboard: boolean;
}

export interface BackStack {
  base: BackBase;
  /** слои поверх — по времени открытия, верхний последний */
  layers: readonly { id: number; run: () => void }[];
  setBase(base: BackBase): void;
  /** Поставить слой; возвращает его номер для снятия. */
  push(run: () => void): number;
  remove(id: number): void;
}

let nextId = 1;

export const useBackStack = create<BackStack>((set, get) => ({
  base: { action: null, keyboard: false },
  layers: [],

  setBase(base): void {
    set({ base });
  },

  push(run): number {
    const id = nextId++;
    set({ layers: [...get().layers, { id, run }] });
    return id;
  },

  remove(id): void {
    set({ layers: get().layers.filter((layer) => layer.id !== id) });
  },
}));

/** Что делает «Назад» сейчас: верхний слой, иначе основа; `null` — кнопки нет. */
export function backAction(stack: Pick<BackStack, "base" | "layers">): (() => void) | null {
  const top = stack.layers.at(-1);
  return top === undefined ? stack.base.action : top.run;
}

/** Есть ли над экраном закрываемая модалка — тогда клавиши экрана ей уступают. */
export function hasBackLayers(): boolean {
  return useBackStack.getState().layers.length > 0;
}

/**
 * Слой модалки на время, пока она открыта. Обработчик берётся последний:
 * модалки передают его стрелкой, новой на каждой отрисовке, и слой из-за этого
 * не должен переставляться наверх. `undefined` — модалку так не закрыть,
 * слоя нет: «Назад» уходит основе.
 */
export function useBackLayer(onBack: (() => void) | undefined): void {
  const latest = useRef(onBack);
  useLayoutEffect(() => {
    latest.current = onBack;
  });
  const closable = onBack !== undefined;

  useEffect(() => {
    if (!closable) return;
    const { push, remove } = useBackStack.getState();
    const id = push(() => latest.current?.());
    return () => remove(id);
  }, [closable]);
}

/**
 * Esc на ПК — тот же «Назад». С модификатором и автоповтором — не команда.
 * В поле ввода Esc закрывает модалку, но не уводит экран: человек, который
 * набирает промокод, отменяет набор, а не уходит из раздела.
 */
export function backKeyAction(
  event: Pick<KeyboardEvent, "key" | "repeat" | "ctrlKey" | "metaKey" | "altKey">,
  stack: Pick<BackStack, "base" | "layers">,
  typing: boolean,
): (() => void) | null {
  if (event.key !== "Escape" || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return null;
  const top = stack.layers.at(-1);
  if (top !== undefined) return top.run;
  return stack.base.keyboard && !typing ? stack.base.action : null;
}
