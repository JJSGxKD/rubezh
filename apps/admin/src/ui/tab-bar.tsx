import type { ReactNode } from "react";

/** Вкладки строкой: активная — черта акцента снизу, число ожидающего — значком; на телефоне прокручивается строка, не страница. */
export function TabBar<T extends string>({
  label,
  tabs,
  active,
  counts = {},
  onSelect,
}: {
  /** подпись строки для экранного диктора: «Карточка игрока», «Прокси» */
  label: string;
  tabs: readonly { id: T; title: string }[];
  active: T;
  /** число у вкладки — значком; нет числа или нуль — значка нет */
  counts?: Partial<Record<T, number>>;
  onSelect: (tab: T) => void;
}): ReactNode {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-border [scrollbar-width:none]">
      {tabs.map((item) => {
        const selected = item.id === active;
        const count = counts[item.id];
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(item.id)}
            className={`-mb-px flex min-h-10 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-medium transition-colors ${selected ? "border-accent text-text" : "border-transparent text-text-muted hover:text-text"}`}
          >
            {item.title}
            {count ? <span className="inline-flex min-w-5 justify-center rounded-pill bg-warning/15 px-1.5 text-xs font-semibold text-warning tabular-nums">{count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
