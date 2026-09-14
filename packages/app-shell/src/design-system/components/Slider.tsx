import { useId, type ReactNode } from "react";

/**
 * Регулятор 0–100 строкой списка: подпись, значение и дорожка во всю ширину.
 * Нативный `range`: клавиатура, экранный диктор и жест по дорожке работают из
 * коробки, а цвет берётся из токена акцента.
 *
 * `onCommit` — когда палец отпущен: движение применяется сразу, а решение
 * игрока пишется одним событием, а не сотней.
 */
export function Slider(props: {
  label: string;
  value: number;
  onChange(value: number): void;
  onCommit?: () => void;
  icon?: ReactNode;
  valueLabel?: string;
}): ReactNode {
  const id = useId();
  return (
    <div className="flex min-h-14 flex-col justify-center gap-1.5 bg-surface px-4 py-3">
      <div className="flex items-center gap-3">
        {props.icon === undefined ? null : <span className="shrink-0 text-text-muted">{props.icon}</span>}
        <label htmlFor={id} className="min-w-0 flex-1 truncate text-sm font-medium text-text">
          {props.label}
        </label>
        <span className="shrink-0 font-display text-sm tabular-nums text-text-muted">{props.valueLabel ?? `${props.value}%`}</span>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={1}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.currentTarget.value))}
        onPointerUp={() => props.onCommit?.()}
        onKeyUp={() => props.onCommit?.()}
        className="h-8 w-full cursor-pointer accent-accent"
      />
    </div>
  );
}
