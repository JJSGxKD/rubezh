import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type Announcements, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { createContext, createElement, useContext, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { INSTRUCTIONS, cancelText, dropText, moveItem, moveText, pickUpText, sameOrder } from "./sortable-order";

/**
 * Список с ручным порядком (tasks/T-0167): перетаскивание мышью, пальцем и с
 * клавиатуры, тексты диктора по-русски. Порядок уходит наверх одним вызовом —
 * `onReorder` с полным новым порядком id, и только если он изменился. Едет
 * вместе с `sortable-order.ts`, где вся логика без React.
 *
 * Ручка — отдельная кнопка: атрибуты и слушатели dnd-kit висят на ней, а не на
 * всей строке, поэтому клик по строке (открыть форму) остаётся кликом.
 */

interface SortableContextValue {
  ids: readonly string[];
  labelOf: (id: string) => string;
  disabled: boolean;
}

const Sortable = createContext<SortableContextValue>({ ids: [], labelOf: (id) => id, disabled: true });

export function SortableList({
  ids,
  labelOf,
  onReorder,
  layout = "rows",
  disabled = false,
  children,
}: {
  ids: readonly string[];
  labelOf: (id: string) => string;
  onReorder: (ids: string[]) => void;
  layout?: "rows" | "grid";
  disabled?: boolean;
  children: ReactNode;
}) {
  const sensors = useSensors(
    // Клик по строке не должен начинать перетаскивание: нужно сдвинуться хотя бы на несколько пикселей.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // Палец: задержка, чтобы прокрутка страницы не хватала строки.
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const value = useMemo<SortableContextValue>(() => ({ ids, labelOf, disabled: disabled || ids.length < 2 }), [ids, labelOf, disabled]);
  const announcements = useMemo(() => announcementsFor(ids, labelOf), [ids, labelOf]);

  const onDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (over === null) return;
    const next = moveItem(ids, String(active.id), String(over.id));
    if (!sameOrder(next, ids)) onReorder(next);
  };

  return (
    <Sortable.Provider value={value}>
      <DndContext
        sensors={value.disabled ? [] : sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
        accessibility={{ announcements, screenReaderInstructions: { draggable: INSTRUCTIONS } }}
      >
        <SortableContext items={[...ids]} strategy={layout === "grid" ? rectSortingStrategy : verticalListSortingStrategy}>
          {children}
        </SortableContext>
      </DndContext>
    </Sortable.Provider>
  );
}

/** Одна строка или карточка. `children` получает ручку; без неё (меньше двух элементов, список заблокирован) вместо ручки — `null`. */
export function SortableItem({
  id,
  as = "div",
  className = "",
  onClick,
  children,
}: {
  id: string;
  as?: "div" | "li" | "tr";
  className?: string;
  onClick?: () => void;
  children: (handle: ReactNode) => ReactNode;
}) {
  const { ids, labelOf, disabled } = useContext(Sortable);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  const reduced = usePrefersReducedMotion();

  const style: CSSProperties = {
    // Двигается только `transform`: остальное перерисовывало бы соседние строки.
    transform: CSS.Transform.toString(transform),
    transition: reduced ? undefined : transition,
    ...(isDragging ? { position: "relative", zIndex: 1 } : {}),
  };

  const handle =
    ids.length < 2 ? null : (
      <button
        ref={setActivatorNodeRef}
        type="button"
        aria-label={`Переставить «${labelOf(id)}»`}
        disabled={disabled}
        // Клик по ручке не открывает строку: он начало или конец перетаскивания, а не выбор.
        onClick={(event) => event.stopPropagation()}
        className="inline-flex size-10 shrink-0 cursor-grab sm:size-8 touch-none items-center justify-center rounded-sm text-text-muted hover:bg-surface-raised hover:text-text focus-visible:outline-2 focus-visible:outline-accent active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={16} aria-hidden="true" />
      </button>
    );

  return createElement(
    as,
    {
      ref: setNodeRef,
      style,
      onClick,
      className: `${className} ${isDragging ? "bg-surface-raised opacity-90 shadow-lg" : ""}`.trim(),
    },
    children(handle),
  );
}

/** Тексты диктора из `sortable-order.ts`: место считается по порядку `ids`, с единицы. */
function announcementsFor(ids: readonly string[], labelOf: (id: string) => string): Announcements {
  const total = ids.length;
  const place = (id: string): number => ids.indexOf(id) + 1;
  return {
    onDragStart: ({ active }) => pickUpText(labelOf(String(active.id)), place(String(active.id)), total),
    onDragOver: ({ active, over }) => (over === null ? undefined : moveText(labelOf(String(active.id)), place(String(over.id)), total)),
    onDragEnd: ({ active, over }) => {
      const id = String(active.id);
      const moved = over !== null && over.id !== active.id;
      return dropText(labelOf(id), over === null ? place(id) : place(String(over.id)), total, moved);
    },
    onDragCancel: ({ active }) => cancelText(labelOf(String(active.id)), place(String(active.id)), total),
  };
}

/** Без анимации перемещения, если игрок попросил меньше движения. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const listen = (event: MediaQueryListEvent): void => setReduced(event.matches);
    query.addEventListener("change", listen);
    return () => query.removeEventListener("change", listen);
  }, []);
  return reduced;
}
