import { useEffect, useRef, type RefObject } from "react";

/** Что в окне берёт фокус клавишей Tab. */
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Куда уводить Tab внутри окна, чтобы фокус ходил по кругу и не уходил под
 * затемнение. `current` — индекс элемента с фокусом среди доступных, −1 —
 * фокус на самом окне. `null` — вмешиваться не нужно, порядок браузера верен.
 */
export function trapIndex(count: number, current: number, backwards: boolean): number | null {
  if (count === 0) return null;
  if (current === -1) return backwards ? count - 1 : 0;
  if (backwards) return current === 0 ? count - 1 : null;
  return current === count - 1 ? 0 : null;
}

/**
 * Фокус окна (docs/27-design-system-and-app-shell.md §4.4). При открытии —
 * на само окно, а не на первую кнопку: Enter не должен случайно нажать
 * «Ещё раз», а диктор начнёт с имени окна. Tab — по кругу внутри. При
 * закрытии — туда, где фокус был до окна, если тот элемент ещё на месте и
 * его не закрывает другое окно.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, active: boolean): void {
  // Куда вернуть фокус — в ref, а не в замыкании эффекта: повторный запуск
  // эффекта (StrictMode в разработке) застаёт фокус уже на окне и запомнил бы
  // само окно, которое к закрытию исчезнет.
  const returnTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!active || dialog === null) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused !== document.body && !dialog.contains(focused)) returnTo.current = focused;
    if (!dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true });

    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((item) => item.getClientRects().length > 0);
      const active = document.activeElement;
      const next = trapIndex(items.length, active instanceof HTMLElement ? items.indexOf(active) : -1, event.shiftKey);
      if (next === null) return;
      event.preventDefault();
      items[next]?.focus();
    };
    dialog.addEventListener("keydown", onKey);
    // Содержимое окна меняется на месте — пауза становится подтверждением
    // «Сдаться?», — и кнопка с фокусом исчезает. Браузер молча отдаёт фокус
    // странице, событий нет; ловим по изменению содержимого.
    const keep = new MutationObserver(() => {
      const now = document.activeElement;
      if (now === null || now === document.body) dialog.focus({ preventScroll: true });
    });
    keep.observe(dialog, { childList: true, subtree: true });
    return () => {
      keep.disconnect();
      dialog.removeEventListener("keydown", onKey);
      // Окно сменилось другим («Сдаться» из паузы открывает подтверждение) —
      // фокус уже у нового, отнимать его нельзя.
      const now = document.activeElement;
      if (now !== null && now !== document.body) return;
      // Под закрытым окном осталось другое — фокус в него, а не под затемнение.
      const others = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter((other) => other !== dialog);
      const before = returnTo.current;
      const top = others[others.length - 1];
      if (top !== undefined && (before === null || !top.contains(before))) {
        top.focus({ preventScroll: true });
        return;
      }
      if (before?.isConnected === true) before.focus({ preventScroll: true });
    };
  }, [ref, active]);
}
