import { useRef, useState, type MouseEvent, type PointerEvent, type RefObject, type UIEvent } from "react";

/**
 * Лента, которая листается по одному элементу: баннеры магазина и карусель
 * главной. Пальцем её прокручивает сам браузер; здесь — то, чего он не умеет:
 * какой элемент сейчас на виду, переход к элементу по точке и перетаскивание
 * мышью.
 *
 * Мышью ленту тянут так же, как пальцем: на ПК и в Telegram Desktop
 * горизонтальной прокрутки колесом у многих нет. Пока тянут, привязка к
 * элементу выключена, иначе лента дёргается под курсором; отпустили —
 * доезжает до ближайшего.
 */

/** Сдвиг мыши, после которого нажатие считается перетаскиванием, а не кликом, px. */
const DRAG_THRESHOLD = 6;

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Шаг между элементами — по вёрстке, а не числом здесь: ширину и зазор задают классы. */
function stepOf(element: HTMLElement): number {
  const first = element.children.item(0);
  const second = element.children.item(1);
  if (!(first instanceof HTMLElement) || !(second instanceof HTMLElement)) return 0;
  return second.offsetLeft - first.offsetLeft;
}

export interface SwipeStrip {
  strip: RefObject<HTMLDivElement | null>;
  /** Какой элемент сейчас на виду. */
  current: number;
  /** Классы ленты: курсор руки и привязка к элементу, пока не тянут. */
  dragClass: string;
  scrollToIndex(index: number): void;
  handlers: {
    onScroll(event: UIEvent<HTMLDivElement>): void;
    onPointerDown(event: PointerEvent<HTMLDivElement>): void;
    onPointerMove(event: PointerEvent<HTMLDivElement>): void;
    onPointerUp(): void;
    onPointerCancel(): void;
    onClickCapture(event: MouseEvent<HTMLDivElement>): void;
  };
}

export function useSwipeStrip(total: number): SwipeStrip {
  const [current, setCurrent] = useState(0);
  const [dragging, setDragging] = useState(false);
  const strip = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; scroll: number; moved: boolean } | null>(null);
  // Клик приходит после отпускания, когда состояние уже сброшено, — помним жест отдельно.
  const justDragged = useRef(false);

  const clampIndex = (element: HTMLDivElement): number | null => {
    const step = stepOf(element);
    return step <= 0 ? null : Math.min(total - 1, Math.max(0, Math.round(element.scrollLeft / step)));
  };

  const scrollToIndex = (index: number): void => {
    const element = strip.current;
    if (element === null) return;
    element.scrollTo({ left: index * stepOf(element), behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };

  const endDrag = (): void => {
    const state = drag.current;
    drag.current = null;
    if (state === null || !state.moved) return;
    justDragged.current = true;
    setDragging(false);
    const element = strip.current;
    const index = element === null ? null : clampIndex(element);
    if (index !== null) scrollToIndex(index);
  };

  return {
    strip,
    current,
    dragClass: dragging ? "cursor-grabbing select-none" : "cursor-grab snap-x snap-mandatory",
    scrollToIndex,
    handlers: {
      onScroll: (event) => {
        const next = clampIndex(event.currentTarget);
        if (next !== null && next !== current) setCurrent(next);
      },
      // Палец и перо прокручивают ленту сами — их не трогаем.
      onPointerDown: (event) => {
        justDragged.current = false;
        if (event.pointerType !== "mouse" || event.button !== 0) return;
        drag.current = { x: event.clientX, scroll: event.currentTarget.scrollLeft, moved: false };
      },
      onPointerMove: (event) => {
        const state = drag.current;
        if (state === null) return;
        const dx = event.clientX - state.x;
        if (!state.moved && Math.abs(dx) < DRAG_THRESHOLD) return;
        if (!state.moved) {
          state.moved = true;
          setDragging(true);
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        event.currentTarget.scrollLeft = state.scroll - dx;
      },
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      // Отпущенная после перетаскивания кнопка не должна срабатывать: это был жест, а не нажатие.
      onClickCapture: (event) => {
        if (!justDragged.current) return;
        justDragged.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    },
  };
}
