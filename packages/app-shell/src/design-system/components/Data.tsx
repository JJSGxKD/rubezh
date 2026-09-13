import type { ReactNode } from "react";

/**
 * Полоса: здоровье, опыт, загрузка.
 *
 * Ширина меняется через `scaleX`, а не через `width`: изменение ширины
 * вызывает перерасчёт раскладки на каждом кадре забега
 * (docs/27-design-system-and-app-shell.md §3.3, правило 2).
 */
export interface ProgressBarProps {
  value: number;
  max: number;
  /** цветовой токен полосы */
  tone?: "hp" | "hp-low" | "xp" | "accent";
  label?: string;
  height?: "thin" | "base";
}

const TONE_CLASS: Record<NonNullable<ProgressBarProps["tone"]>, string> = {
  hp: "bg-hp",
  "hp-low": "bg-hp-low",
  xp: "bg-xp",
  accent: "bg-accent",
};

export function ProgressBar(props: ProgressBarProps): ReactNode {
  const ratio = props.max <= 0 ? 0 : Math.min(1, Math.max(0, props.value / props.max));

  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(props.value)}
      aria-valuemax={Math.round(props.max)}
      aria-label={props.label}
      className={[
        "w-full overflow-hidden rounded-pill bg-surface-raised",
        props.height === "thin" ? "h-1" : "h-2",
      ].join(" ")}
    >
      <div
        className={[
          "h-full origin-left rounded-pill",
          "transition-transform duration-(--duration-fast) ease-base",
          TONE_CLASS[props.tone ?? "accent"],
        ].join(" ")}
        style={{ transform: `scaleX(${ratio})` }}
      />
    </div>
  );
}

/** Подпись и значение. Крупный вариант — для экрана смерти. */
export function Stat(props: { label: string; value: string; large?: boolean }): ReactNode {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-text-muted">{props.label}</span>
      <span
        className={[
          "font-display tabular-nums text-text",
          props.large === true ? "text-2xl" : "text-base",
        ].join(" ")}
      >
        {props.value}
      </span>
    </div>
  );
}

export function Badge(props: { children: ReactNode; tone?: "muted" | "accent" | "warning" }): ReactNode {
  const tone = props.tone ?? "muted";
  const toneClass =
    tone === "accent"
      ? "bg-accent/15 text-accent"
      : tone === "warning"
        ? "bg-warning/15 text-warning"
        : "bg-surface-raised text-text-muted";

  return (
    <span className={`rounded-pill px-2 py-0.5 text-xs ${toneClass}`}>{props.children}</span>
  );
}

/** Аватар с запасным вариантом из инициалов: фото площадка отдаёт не всегда. */
export function Avatar(props: { name: string; url?: string | null; size?: number }): ReactNode {
  const size = props.size ?? 36;
  const initials = props.name
    .split(" ")
    .filter((part) => part !== "")
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  if (props.url !== null && props.url !== undefined && props.url !== "") {
    return (
      <img
        src={props.url}
        alt=""
        width={size}
        height={size}
        className="rounded-full object-cover"
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className="inline-flex items-center justify-center rounded-full bg-surface-raised font-display text-sm text-text-muted"
    >
      {initials === "" ? "?" : initials}
    </span>
  );
}

/** Валюта в верхней панели. На этапе 2 — заглушка с нулём. */
export function CurrencyChip(props: { icon: ReactNode; value: string }): ReactNode {
  return (
    <span className="inline-flex items-center gap-1 rounded-pill bg-surface-raised px-2 py-1 text-xs tabular-nums text-text-muted">
      {props.icon}
      {props.value}
    </span>
  );
}
