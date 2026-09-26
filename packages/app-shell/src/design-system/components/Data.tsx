import { useState, type ReactNode } from "react";

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
  tone?: "hp" | "hp-low" | "xp" | "accent" | "boss";
  label?: string;
  height?: "thin" | "base" | "thick";
  /** бегущий блик — полоса «живая», пока идёт загрузка */
  shimmer?: boolean;
}

const TONE_CLASS: Record<NonNullable<ProgressBarProps["tone"]>, string> = {
  hp: "fill-hp",
  "hp-low": "fill-hp-low",
  xp: "fill-xp",
  accent: "fill-accent",
  boss: "fill-boss",
};

const HEIGHT_CLASS: Record<NonNullable<ProgressBarProps["height"]>, string> = {
  thin: "h-1.5",
  base: "h-2.5",
  thick: "h-3.5",
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
        "surface-sunken relative w-full overflow-hidden rounded-pill",
        HEIGHT_CLASS[props.height ?? "base"],
      ].join(" ")}
    >
      <div
        className={[
          "h-full origin-left rounded-pill",
          "transition-transform duration-(--duration-slow) ease-out",
          TONE_CLASS[props.tone ?? "accent"],
        ].join(" ")}
        style={{ transform: `scaleX(${ratio})` }}
      />
      {props.shimmer === true ? (
        <div aria-hidden="true" className="absolute inset-0 animate-shimmer">
          <div className="h-full w-1/3 bg-linear-to-r from-transparent via-text/25 to-transparent" />
        </div>
      ) : null}
    </div>
  );
}

/** Подпись и значение. Крупный вариант — для экрана смерти. */
export function Stat(props: { label: string; value: string; large?: boolean; tone?: "accent" }): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="font-display text-xs font-semibold tracking-wide text-text-muted uppercase">
        {props.label}
      </span>
      <span
        className={[
          "font-display font-bold tabular-nums",
          props.tone === "accent" ? "text-accent" : "text-text",
          props.large === true ? "text-2xl" : "text-lg",
        ].join(" ")}
      >
        {props.value}
      </span>
    </div>
  );
}

export type BadgeTone = "muted" | "accent" | "warning" | "info" | "weapon" | "passive";

const BADGE_TONE_CLASS: Record<BadgeTone, string> = {
  muted: "bg-surface-raised text-text-muted",
  accent: "bg-accent/15 text-accent",
  warning: "bg-warning/15 text-warning",
  info: "bg-info/15 text-info",
  weapon: "bg-weapon/15 text-weapon",
  passive: "bg-passive/15 text-passive",
};

export function Badge(props: { children: ReactNode; tone?: BadgeTone }): ReactNode {
  return (
    <span
      className={[
        "inline-flex items-center gap-1 rounded-pill px-2 py-0.5",
        "font-display text-xs font-semibold tracking-wide whitespace-nowrap uppercase",
        BADGE_TONE_CLASS[props.tone ?? "muted"],
      ].join(" ")}
    >
      {props.children}
    </span>
  );
}

/** Аватар с запасным вариантом из инициалов: фото площадка отдаёт не всегда. */
export function Avatar(props: { name: string; url?: string | null; size?: number }): ReactNode {
  const size = props.size ?? 36;
  // Фото не загрузилось — инициалы, а не значок битой картинки: адрес
  // приходит с t.me, а он открывается не из любой сети. Запоминается сам
  // адрес — новое фото пробуется заново.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const initials = props.name
    .split(" ")
    .filter((part) => part !== "")
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  const url = props.url;
  if (url !== null && url !== undefined && url !== "" && url !== failedUrl) {
    return (
      <img
        src={url}
        onError={() => setFailedUrl(url)}
        alt=""
        width={size}
        height={size}
        className="rounded-full border-2 border-border-strong object-cover"
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className="surface-card inline-flex items-center justify-center rounded-full font-display text-sm font-bold text-text-muted"
    >
      {initials === "" ? "?" : initials}
    </span>
  );
}

/** Валюта в верхней панели. На этапе 2 — заглушка с нулём. */
export function CurrencyChip(props: { icon: ReactNode; value: string }): ReactNode {
  return (
    <span className="surface-sunken inline-flex items-center gap-1.5 rounded-pill py-1 pr-3 pl-1">
      <span className="inline-flex size-6 items-center justify-center rounded-full bg-info/15 text-info">
        {props.icon}
      </span>
      <span className="font-display text-sm font-bold tabular-nums text-text">{props.value}</span>
    </span>
  );
}
