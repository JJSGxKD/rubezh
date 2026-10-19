export type SegmentedSize = "m" | "s";
export type SegmentedLayout = "row" | "grid";

/** Сколько сегментов помещается строкой; больше — сетка в два столбца. */
export const SEGMENTS_IN_ROW = 3;

export function segmentedLayout(itemCount: number): SegmentedLayout {
  return itemCount > SEGMENTS_IN_ROW ? "grid" : "row";
}

/**
 * Поля и шрифт сегмента. `s` шире 384 px не отличается от `m`; уже — сжимается
 * ступенями по ширине экрана, чтобы три русские подписи («Нормальная») не
 * уходили за край. Размеры — токены, произвольных значений нет.
 */
export function segmentFitClass(size: SegmentedSize): string {
  return size === "s"
    ? "px-2 text-sm max-[24rem]:px-1 max-[24rem]:text-xs max-[22.5rem]:px-0.5 max-[22.5rem]:tracking-tighter"
    : "px-2 text-sm";
}
