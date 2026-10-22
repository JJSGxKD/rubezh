import type { ReactNode } from "react";

/**
 * Наши валюты — монета и самоцвет (docs/35-stage4-plan.md, Р27, Р34), облик v2
 * (design/art/direction-v2.md §7.2). Монета — чеканка рубежа: на золоте руна
 * Ж с ромбом, как в логотипе; самоцвет — огранённый рубин с искрой. Оба с
 * тёмным контуром и выдавленным низом, как логотип и окна наград: значок
 * читается и на тёмной плашке, и на оранжевой кнопке. Монета со звездой не
 * рисуется — рядом со звёздами Telegram её приняли бы за них.
 *
 * Иконки многотонные и перекрашиваются палитрой, а не одним цветом: каждый
 * тон — токен (`--color-coin-*`, `--color-gem-*`, `--color-ink` в tokens.css),
 * и смена визуального направления меняет их вместе с остальной палитрой.
 * Руна на монете проще, чем в логотипе: три штриха и ромб — на 14 px больше
 * деталей слиплось бы в пятно.
 */
export function CoinIcon(props: { size?: number }): ReactNode {
  const size = props.size ?? 18;
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <circle cx="20" cy="20.6" r="19.4" fill="var(--color-ink)" />
      <circle cx="20" cy="21.4" r="17.4" fill="var(--color-coin-deep)" />
      <circle cx="20" cy="19.6" r="17.4" fill="var(--color-coin-lo)" />
      <circle cx="20" cy="18.8" r="15.4" fill="var(--color-coin)" />
      <path d="M20 9.6V28.4M13.2 11.4L20 19.4L26.8 11.4M13.2 26.6L20 18.6L26.8 26.6" stroke="var(--color-coin-deep)" strokeWidth="3.6" />
      <path d="M20 15.4L23.4 19L20 22.6L16.6 19Z" fill="var(--color-coin-hi)" stroke="var(--color-coin-deep)" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M7.6 15.2A13 13 0 0 1 14.6 7.4" stroke="#fff" strokeOpacity="0.8" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function GemIcon(props: { size?: number }): ReactNode {
  const size = props.size ?? 18;
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <path d="M20 1.5L35.5 13.5L20 38.5L4.5 13.5Z" fill="var(--color-ink)" stroke="var(--color-ink)" strokeWidth="3" strokeLinejoin="round" />
      <path d="M20 3.5L33.5 13.5L20 36L6.5 13.5Z" fill="var(--color-gem)" />
      <path d="M6.5 13.5H33.5L20 36Z" fill="var(--color-gem-lo)" />
      <path d="M6.5 13.5L20 36L14 13.5Z" fill="var(--color-gem-deep)" fillOpacity="0.55" />
      <path d="M20 3.5L6.5 13.5H14Z" fill="var(--color-gem-light)" />
      <path d="M20 3.5L14 13.5H26Z" fill="var(--color-gem-hi)" />
      <path d="M14 13.5L20 36L26 13.5Z" fill="var(--color-gem-light)" fillOpacity="0.75" />
      <path d="M11 10.6L13.2 9.1" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M30.5 4.5L31.5 7L34 8L31.5 9L30.5 11.5L29.5 9L27 8L29.5 7Z" fill="#fff" />
    </svg>
  );
}
