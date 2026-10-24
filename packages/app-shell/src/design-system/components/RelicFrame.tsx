import type { CSSProperties, ReactNode } from "react";

/**
 * Панель-реликвия дизайн-системы v2 (design/art/direction-v2.md §4.4): окно
 * награды как вещь мира — сумеречный ларец с каймой-оберегом сверху и снизу
 * и розетками в углах. Тон — CSS-значение из токенов (`var(--color-elite)`):
 * им красятся кайма, розетки, свет сверху и рамка.
 *
 * Только `transform` и `opacity` у всего, что движется рядом: сама панель
 * статична, узоры — маской и фоном.
 */
export function RelicFrame(props: { tone: string; className?: string; children: ReactNode }): ReactNode {
  const style = { "--relic-tone": props.tone, color: "var(--color-text)" } as CSSProperties;
  return (
    <div className={`relic-frame relative flex max-h-full w-full flex-col overflow-hidden rounded-xl ${props.className ?? ""}`} style={style}>
      <span aria-hidden="true" className="relic-band pointer-events-none absolute inset-x-8 top-1 h-2.5" />
      <span aria-hidden="true" className="relic-band pointer-events-none absolute inset-x-8 bottom-1 h-2.5" />
      <Rosette className="top-1 left-1" />
      <Rosette className="top-1 right-1 -scale-x-100" />
      <Rosette className="bottom-1 left-1 -scale-y-100" />
      <Rosette className="right-1 bottom-1 -scale-100" />
      {props.children}
    </div>
  );
}

/** Розетка угла: ромб-оберег с лучами вдоль краёв — продолжение каймы. */
function Rosette(props: { className: string }): ReactNode {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 28 28"
      className={`pointer-events-none absolute size-7 ${props.className}`}
      style={{ color: "var(--relic-tone)" }}
    >
      <path d="M2 2h9M2 2v9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.8" />
      <path d="M8 3 13 8 8 13 3 8z" fill="currentColor" opacity="0.9" />
      <path d="M8 6 10 8 8 10 6 8z" fill="var(--color-bg)" />
      <circle cx="17" cy="3" r="1.2" fill="currentColor" opacity="0.7" />
      <circle cx="3" cy="17" r="1.2" fill="currentColor" opacity="0.7" />
    </svg>
  );
}

/**
 * Заголовок на ленте с надрезанными концами — так подписывают награду, а
 * не раздел настроек. Текст тёмный по тону ленты.
 */
export function RibbonTitle(props: { id?: string; tone: string; children: ReactNode; className?: string }): ReactNode {
  return (
    <div className={`relative mx-auto inline-flex items-center px-8 py-1.5 ${props.className ?? ""}`}>
      <svg aria-hidden="true" viewBox="0 0 200 40" preserveAspectRatio="none" className="absolute inset-0 size-full">
        <path d="M0 4h200l-12 16 12 16H0l12-16z" fill={props.tone} />
        <path d="M0 4h200l-12 16 12 16H0l12-16z" fill="none" stroke="var(--color-bg)" strokeOpacity="0.35" strokeWidth="2" />
        <path d="M14 9h172M14 31h172" stroke="var(--color-bg)" strokeOpacity="0.25" strokeWidth="1.2" />
      </svg>
      <h2 id={props.id} className="relative font-display text-xl font-bold whitespace-nowrap text-on-accent short:text-lg">
        {props.children}
      </h2>
    </div>
  );
}

/**
 * «Новое» уголком-лентой в правом верхнем углу карточки или строки: новое
 * важнее уровня и читается до текста. Родитель — `relative overflow-hidden`.
 */
export function CornerRibbon(props: { children: ReactNode; className?: string; style?: CSSProperties }): ReactNode {
  return (
    <span
      className={`absolute top-0 right-0 rounded-bl-md bg-accent px-2 py-0.5 font-display text-[10px] font-bold tracking-wide text-on-accent uppercase ${props.className ?? ""}`}
      style={props.style}
    >
      {props.children}
    </span>
  );
}
