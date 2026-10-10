import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { uiFeedback } from "../state/ui-feedback";

/**
 * Плитка выбора в листе «Перед забегом» (docs/35-stage4-plan.md, Р88) —
 * общая у оружия и бустов. Две строки: сверху значок и то, что справа от него
 * (цена буста или уровень у закрытого оружия), ниже имя во всю ширину — так
 * оно не обрезается и на 320 px.
 */
export interface PickTileProps {
  icon: ReactNode;
  /** тон подложки значка: оружие — `weapon`, бусты — `info` */
  tone: "weapon" | "info";
  name: string;
  /** справа от значка: цена буста или замок с уровнем у закрытого оружия */
  corner?: ReactNode;
  selected: boolean;
  /** закрытое оружие — замок, нажатие ничего не делает */
  locked?: boolean;
  /** буст не по карману или выбрано максимум — приглушён до 40% */
  disabled?: boolean;
  onClick?: () => void;
}

const TONE_CLASS: Record<PickTileProps["tone"], string> = {
  weapon: "bg-weapon/15 text-weapon",
  info: "bg-info/15 text-info",
};

export function PickTile(props: PickTileProps): ReactNode {
  const locked = props.locked === true;
  const disabled = props.disabled === true;
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      aria-disabled={locked || disabled ? true : undefined}
      disabled={disabled}
      onClick={() => {
        if (locked) return;
        uiFeedback("select");
        props.onClick?.();
      }}
      className={[
        "surface-card relative flex w-full min-w-0 flex-col items-stretch gap-1 rounded-lg p-2 text-left max-[359px]:p-1.5",
        "transition-[transform,opacity] duration-(--duration-fast) ease-base",
        locked ? "opacity-55" : "active:scale-[0.98]",
        disabled ? "opacity-40" : "",
        props.selected ? "ring-2 ring-accent shadow-[0_0_18px_-8px_var(--color-accent)]" : "ring-1 ring-border-strong",
      ].join(" ")}
    >
      <span className="flex min-h-7 items-center justify-between gap-1.5 max-[359px]:gap-1">
        <span
          className={[
            "inline-flex size-7 shrink-0 items-center justify-center rounded-md max-[359px]:size-6",
            locked ? "bg-surface-sunken text-text-disabled" : TONE_CLASS[props.tone],
          ].join(" ")}
        >
          {props.icon}
        </span>
        {props.corner === undefined ? null : (
          <span className="inline-flex min-w-0 items-center gap-1 text-[11.5px] leading-none font-semibold whitespace-nowrap tabular-nums text-text-muted">
            {props.corner}
          </span>
        )}
      </span>
      <span className="block truncate font-display text-[12.5px] leading-tight text-text">{props.name}</span>
      {props.selected ? (
        <span aria-hidden="true" className="absolute -top-1.5 -right-1.5 inline-flex size-4 items-center justify-center rounded-sm bg-accent text-on-accent">
          <Check size={11} strokeWidth={3.5} />
        </span>
      ) : null}
    </button>
  );
}
