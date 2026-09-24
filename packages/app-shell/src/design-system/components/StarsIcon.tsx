import { useId, type ReactNode } from "react";

/** Контур звезды Telegram Stars в сетке 15 × 15 — один на заливку и блик. */
const STARS_PATH =
  "M7.144 12.127L4.144 14.049C3.832 14.249 3.424 14.146 3.233 13.82C3.139 13.661 3.112 13.469 3.156 13.288L3.62 11.376C3.788 10.686 4.239 10.11 4.853 9.801L8.127 8.158C8.279 8.082 8.344 7.89 8.27 7.731C8.211 7.601 8.077 7.529 7.942 7.554L4.298 8.213C3.557 8.347 2.798 8.133 2.221 7.628L1.07 6.62C0.79 6.374 0.753 5.937 0.988 5.644C1.102 5.502 1.267 5.413 1.444 5.399L4.961 5.111C5.21 5.09 5.426 4.926 5.522 4.685L6.878 1.261C7.018 0.908 7.406 0.74 7.744 0.886C7.906 0.957 8.035 1.091 8.102 1.261L9.459 4.685C9.555 4.926 9.771 5.09 10.02 5.111L13.556 5.4C13.921 5.43 14.193 5.763 14.165 6.145C14.151 6.328 14.068 6.498 13.934 6.618L11.237 9.022C11.047 9.191 10.964 9.457 11.023 9.711L11.852 13.312C11.938 13.684 11.719 14.058 11.363 14.147C11.192 14.191 11.012 14.161 10.862 14.065L7.836 12.127C7.624 11.991 7.357 11.991 7.144 12.127Z";

/**
 * Звезда Telegram Stars — валюта оплаты в Telegram (docs/34-stage3-plan.md,
 * WP5). Взята из vpnsibcom_web (`tg-star-original.svg`) без маски и обрезки,
 * которые там ничего не делали; координаты контура округлены до тысячных.
 *
 * Цвета — фирменные цвета Stars, а не наш визуальный стиль: их задаёт
 * Telegram, и при смене направления в `tokens.css` они меняться не должны,
 * как не меняется чужой логотип. Поэтому они здесь, а не в токенах.
 *
 * Идентификаторы градиентов свои у каждого экземпляра: звёзд на экране бывает
 * несколько, а общий `id` в документе один.
 *
 * Свой модуль и импорт мимо `index.ts`: модуль значков грузится с первой
 * загрузкой, а звезда нужна только экрану смерти — в общем модуле она уехала
 * бы туда же (docs/27-design-system-and-app-shell.md §3.4).
 */
export function StarsIcon(props: { size?: number }): ReactNode {
  const size = props.size ?? 18;
  const id = useId();
  const fill = `${id}-fill`;
  const edge = `${id}-edge`;
  const shine = `${id}-shine`;
  return (
    <svg width={size} height={size} viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d={STARS_PATH} fill={`url(#${fill})`} stroke={`url(#${edge})`} />
      <path fillRule="evenodd" clipRule="evenodd" d={STARS_PATH} fill={`url(#${shine})`} />
      <defs>
        <linearGradient id={fill} x1="-0.16" y1="17.06" x2="25.96" y2="-11.27" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFE97A" />
          <stop offset="0.22" stopColor="#FFD000" />
          <stop offset="0.6" stopColor="#FF8F00" />
          <stop offset="1" stopColor="#C24A00" />
        </linearGradient>
        <linearGradient id={edge} x1="16.02" y1="1.51" x2="4.97" y2="8.8" gradientUnits="userSpaceOnUse">
          <stop stopColor="#7A2E00" />
          <stop offset="1" stopColor="#FF9145" />
        </linearGradient>
        <radialGradient id={shine} cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(4 2.5) scale(7)">
          <stop stopColor="white" stopOpacity="0.32" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </radialGradient>
      </defs>
    </svg>
  );
}
