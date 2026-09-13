import { useId, type ReactNode } from "react";
import { t } from "../../i18n";

/**
 * Знак игры: ромб-рубеж с горизонтом. Нарисован разметкой, а не картинкой —
 * ноль запросов и чёткость на любой плотности экрана. Та же фигура лежит в
 * index.html заставкой, чтобы переход от заставки к оболочке не мигал.
 *
 * Цвета — из токенов через CSS-переменные; идентификатор градиента уникален,
 * иначе два знака на одном экране делили бы один `<linearGradient>`.
 */
export function Emblem(props: { size?: number; animated?: boolean }): ReactNode {
  const size = props.size ?? 72;
  const gradientId = `emblem-${useId().replace(/:/g, "")}`;

  return (
    <span
      className="relative isolate inline-flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <span
        aria-hidden="true"
        className="halo-accent pointer-events-none absolute -inset-1/2 -z-10 animate-glow rounded-full"
      />
      <svg
        viewBox="0 0 64 64"
        width={size}
        height={size}
        aria-hidden="true"
        className={props.animated === true ? "animate-float" : undefined}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: "var(--color-accent-glow)" }} />
            <stop offset="0.55" style={{ stopColor: "var(--color-accent)" }} />
            <stop offset="1" style={{ stopColor: "var(--color-accent-edge)" }} />
          </linearGradient>
        </defs>
        <path
          d="M32 4 L60 32 L32 60 L4 32 Z"
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth="4"
          strokeLinejoin="round"
        />
        <path d="M32 16 L48 32 L32 48 L16 32 Z" fill={`url(#${gradientId})`} />
        <path d="M10 32 H54" style={{ stroke: "var(--color-bg)" }} strokeWidth="3" />
      </svg>
    </span>
  );
}

/** Название игры акцидентным шрифтом: разрядка и заглавные читаются как логотип. */
export function Wordmark(props: { size?: "m" | "l" }): ReactNode {
  return (
    <span
      className={[
        "font-display font-extrabold tracking-widest text-text uppercase",
        props.size === "l" ? "text-4xl landscape:text-2xl" : "text-2xl",
      ].join(" ")}
    >
      {t("app.name")}
    </span>
  );
}
