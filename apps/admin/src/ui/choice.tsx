import type { ReactNode } from "react";
import { RadioGroup } from "radix-ui";

export interface Choice<T extends string> {
  value: T;
  title: ReactNode;
  /** что выбор значит — мелко под заголовком */
  description?: ReactNode;
  /** справа от заголовка: состояние, бейдж */
  aside?: ReactNode;
  disabled?: boolean;
}

const COLUMNS = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4" } as const;

/**
 * Выбор одного из нескольких карточками (Radix RadioGroup): у каждого
 * варианта видно, что он значит, а недоступный остаётся на виду с причиной —
 * понятно не только что выбрать, но и почему другого нет. Стрелки клавиатуры
 * ходят по вариантам, как у обычной группы переключателей.
 */
export function ChoiceCards<T extends string>({
  label,
  value,
  choices,
  onChange,
  columns = 2,
  disabled = false,
}: {
  label: string;
  value: T | "";
  choices: readonly Choice<T>[];
  onChange: (value: T) => void;
  columns?: keyof typeof COLUMNS;
  disabled?: boolean;
}) {
  return (
    <RadioGroup.Root
      aria-label={label}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        const found = choices.find((choice) => choice.value === next);
        if (found !== undefined) onChange(found.value);
      }}
      className={`grid gap-2 ${COLUMNS[columns]}`}
    >
      {choices.map((choice) => (
        <RadioGroup.Item
          key={choice.value}
          value={choice.value}
          disabled={choice.disabled === true}
          className="flex flex-col items-start gap-1 rounded-sm border border-border bg-surface-sunken px-3 py-2.5 text-left transition-colors hover:border-border-strong focus-visible:border-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border data-[state=checked]:border-accent data-[state=checked]:bg-accent/10"
        >
          <span className="flex w-full items-center justify-between gap-2 text-sm font-medium text-text">
            {/* Заголовок — одним элементом: иначе куски текста с кодом разъедутся по ширине. */}
            <span>{choice.title}</span>
            {choice.aside}
          </span>
          {choice.description === undefined ? null : <span className="text-xs leading-snug text-text-muted">{choice.description}</span>}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
