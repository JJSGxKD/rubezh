import type { ReactNode } from "react";

/**
 * Значки, которых нет в наборе lucide. Нарисованы в той же сетке 24 × 24 и тем
 * же контуром, чтобы стоять в одном ряду с остальными без разнобоя.
 */

/**
 * Нагрудник — раздел «Арсенал». Скрещённые мечи читались как «здесь
 * сражаются» и спорили с кнопкой боя, а арсенал — это снаряжение.
 */
export function ArmorIcon(props: { size?: number }): ReactNode {
  const size = props.size ?? 24;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8.5 3 5 4.6 3 9.5l3 1.1V19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-8.4l3-1.1-2-4.9L15.5 3a4 4 0 0 1-7 0Z" />
      <path d="M12 7.2V21" />
      <path d="M8.5 12.5c1 .7 2.2 1 3.5 1s2.5-.3 3.5-1" />
    </svg>
  );
}
