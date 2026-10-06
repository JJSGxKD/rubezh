import type { ReactNode } from "react";

/**
 * Наши валюты — монета и самоцвет (docs/35-stage4-plan.md, Р27, Р34).
 * Иконки нарисовал участник 1 в Figma; монета — с короной, самоцвет — алый
 * кристалл. Монета со звездой из той же выгрузки не взята: рядом со звёздами
 * Telegram её приняли бы за них.
 *
 * Иконки многотонные и перекрашиваются палитрой, а не одним цветом: каждый
 * тон — токен (`--color-coin-*`, `--color-gem-*` в tokens.css), и смена
 * визуального направления меняет их вместе с остальной палитрой.
 *
 * Монета перерисована по выгрузке геометрически: половины кругов — дугами и
 * наложением, а не вырезами, корона — прямыми с закруглёнными углами. В
 * выгрузке те же фигуры шли десятками кривых, и шапка — первая загрузка —
 * выходила за бюджет (docs/27-design-system-and-app-shell.md §3.4). Кристалл
 * — многоугольники выгрузки, округлённые до десятых в сетке 40 × 40.
 */

type Shape = readonly [d: string, fill: string];

const COIN: readonly Shape[] = [
  ["M20 0A20 20 0 0 0 20 40Z", "var(--color-coin-hi)"],
  ["M20 0A20 20 0 0 1 20 40Z", "var(--color-coin)"],
  ["M20 4.8A15.2 15.2 0 0 0 20 35.2Z", "var(--color-coin)"],
  ["M20 4.8A15.2 15.2 0 0 1 20 35.2Z", "var(--color-coin-lo)"],
  ["M20 14.1V25.8H13.4Q12.9 25.7 12.7 25.3L11 16.8Q11.2 15.6 12.4 15.7L16.5 17.7L19.1 14.5Q19.5 14.1 20 14.1Z", "var(--color-coin-hi)"],
  ["M20 14.1Q20.5 14.1 20.9 14.5L23.5 17.7L27.6 15.7Q28.8 15.6 29 16.8L27.3 25.3Q27.1 25.7 26.6 25.8H20Z", "var(--color-coin)"],
];

const GEM: readonly Shape[] = [
  ["M25.5 12.3V27.7L34.2 29.8V10.2L25.5 12.3Z", "var(--color-gem-lo)"],
  ["M27.1 13.9L34.2 10.2L20 0L18.4 10.4L27.1 13.9Z", "var(--color-gem)"],
  ["M18.4 29.6L20 40L34.2 29.8L27.1 26.1L18.4 29.6Z", "var(--color-gem)"],
  ["M20 8.8L18.4 20L20 31.2L27.1 26.1V13.9L20 8.8Z", "var(--color-gem-light)"],
  ["M11.4 12.3V27.7L20 31.2V8.8L11.4 12.3Z", "var(--color-gem-hi)"],
  ["M12.9 26.1L8.9 25.9L5.8 29.8L20 40V31.2L12.9 26.1Z", "var(--color-gem-light)"],
  ["M20 8.8V0L5.8 10.2L8.9 14.2L12.9 13.9L20 8.8Z", "var(--color-gem-light)"],
  ["M12.9 13.9L5.8 10.2V29.8L12.9 26.1V13.9Z", "var(--color-gem)"],
];

function Shapes(props: { shapes: readonly Shape[]; size: number }): ReactNode {
  return (
    <svg width={props.size} height={props.size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
      {props.shapes.map(([d, fill]) => (
        <path key={d} fillRule="evenodd" clipRule="evenodd" d={d} fill={fill} />
      ))}
    </svg>
  );
}

export function CoinIcon(props: { size?: number }): ReactNode {
  return <Shapes shapes={COIN} size={props.size ?? 18} />;
}

export function GemIcon(props: { size?: number }): ReactNode {
  return <Shapes shapes={GEM} size={props.size ?? 18} />;
}
