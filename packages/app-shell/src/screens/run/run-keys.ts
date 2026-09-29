import { useEffect } from "react";
import { useRun, type RunPhase } from "../../state/run";

/**
 * Клавиатура в забеге (`35-stage4-plan.md`, Р57): на ПК и в браузере играть
 * без мыши. Движение — WASD и стрелки — уже в движке; здесь — то, что
 * решает оболочка: пауза, выбор улучшения, «Ещё раз».
 *
 * Клавиши — по физическому положению (`event.code`), а не по букве: на
 * русской раскладке P — это «з», и пауза не должна зависеть от раскладки.
 *
 * На экране второго шанса клавиш нет сознательно: случайный Enter не должен
 * купить продолжение за звёзды.
 */

export type RunKeyAction = { kind: "pause" } | { kind: "resume" } | { kind: "choose"; index: number } | { kind: "restart" };

// Бюджет интерфейса забега тесный (`27-design-system-and-app-shell.md`
// §3.4): клавиши — выражениями, а не таблицами.
const PAUSE = /^(Escape|KeyP)$/;
const CONFIRM = /^(Enter|NumpadEnter|Space)$/;
const DIGIT = /^(?:Digit|Numpad)([1-4])$/;

export function runKeyAction(code: string, phase: RunPhase, offers: number): RunKeyAction | null {
  if (phase === "running" && PAUSE.test(code)) return { kind: "pause" };
  if (phase === "paused" && (PAUSE.test(code) || CONFIRM.test(code))) return { kind: "resume" };
  const index = Number(DIGIT.exec(code)?.[1] ?? 0) - 1;
  if (phase === "levelUp" && index >= 0 && index < offers) return { kind: "choose", index };
  if (phase === "finished" && CONFIRM.test(code)) return { kind: "restart" };
  return null;
}

/** Нажатие в поле ввода, с модификатором или автоповтор клавиши — не команда забегу. */
function ignored(event: KeyboardEvent): boolean {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return true;
  const target = event.target;
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

/** `enabled` — нет открытого листа: у листа своя клавиша Esc — закрыть его. */
export function useRunKeyboard(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent): void => {
      if (ignored(event)) return;
      // Esc закрывает открытый лист — «Сдаться?», характеристики, — а не
      // снимает игру с паузы вместе с ним.
      if (event.code === "Escape" && document.querySelector('[role="dialog"][data-dismissable="true"]') !== null) return;
      const run = useRun.getState();
      const action = runKeyAction(event.code, run.phase, run.offers.length);
      if (action === null) return;
      // Esc внутри Telegram Desktop не должен уйти клиенту и закрыть приложение.
      event.preventDefault();
      if (action.kind === "pause") run.pause("manual");
      else if (action.kind === "resume") run.resume();
      else if (action.kind === "restart") run.restart();
      else {
        const offer = run.offers[action.index];
        if (offer !== undefined) run.choose(offer.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
