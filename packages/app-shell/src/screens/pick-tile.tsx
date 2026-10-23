import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { uiFeedback } from "../state/ui-feedback";
import { SELECTED_MARK_CLASS } from "./pick-tile-rules";

/**
 * Плитка выбора в листе «Перед забегом» (docs/35-stage4-plan.md, Р88) —
 * общая у оружия и бустов. Две строки: сверху значок и то, что справа от него
 * (цена буста или уровень у закрытого оружия), ниже имя во всю ширину — так
 * оно не обрезается и на 320 px. Значок выбора лежит внутри плитки, а не
 * торчит за её угол: выступ дал бы прокручиваемому листу горизонтальную полосу.
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
  /** у закрытого оружия — «Название. Откроется на N уровне»: диктор слышит, когда оно откроется */
  ariaLabel?: string;
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
      aria-label={props.ariaLabel}
      aria-disabled={locked || disabled ? true : undefined}
      disabled={disabled}
      onClick={() => {
        if (locked) return;
        uiFeedback("select");
        props.onClick?.();
      }}
      className={[
        "surface-card relative flex w-full min-w-0 flex-col items-stretch gap-[4px] rounded-lg p-[8px] text-left max-[359px]:p-[6px]",
        "transition-[transform,opacity] duration-(--duration-fast) ease-base",
        locked ? "opacity-55" : "active:scale-[0.98]",
        disabled ? "opacity-40" : "",
        props.selected ? "ring-2 ring-accent shadow-[0_0_18px_-8px_var(--color-accent)]" : "ring-1 ring-border-strong",
      ].join(" ")}
    >
      <span className="flex min-h-[28px] items-center justify-between gap-[6px] max-[359px]:gap-[4px]">
        <span
          className={[
            // Рамка значка, поля и зазоры плитки — в px, как и её подписи: с
            // крупным шрифтом системы они в rem росли и выдавливали «ур. N»
            // за край плитки.
            "inline-flex size-[28px] shrink-0 items-center justify-center rounded-md max-[359px]:size-[24px]",
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
        <span aria-hidden="true" className={SELECTED_MARK_CLASS}>
          <Check size={10} strokeWidth={3.5} />
        </span>
      ) : null}
    </button>
  );
}
