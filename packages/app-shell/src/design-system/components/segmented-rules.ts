export type SegmentedSize = "m" | "s";
/** `row` — лунка с кнопками, `tabs` — строка вкладок с подчёркиванием и прокруткой. */
export type SegmentedLayout = "row" | "tabs";

/** Сколько сегментов помещается лункой; больше — вкладки строкой (Р145): сетка 2×2 читалась как два переключателя. */
export const SEGMENTS_IN_ROW = 3;

export function segmentedLayout(itemCount: number): SegmentedLayout {
  return itemCount > SEGMENTS_IN_ROW ? "tabs" : "row";
}

/** Ширина затухания у края строки вкладок, px. */
export const EDGE_FADE_PX = 16;

/** Допуск на дробную прокрутку: край ближе пикселя уже считается достигнутым. */
const EDGE_TOLERANCE_PX = 1;

export interface EdgeFade {
  left: boolean;
  right: boolean;
}

/** За каким краем строки есть ещё вкладки: там показывается затухание. Всё помещается — ни одного. */
export function edgeFade(scrollLeft: number, clientWidth: number, scrollWidth: number): EdgeFade {
  return {
    left: scrollLeft > EDGE_TOLERANCE_PX,
    right: scrollLeft + clientWidth < scrollWidth - EDGE_TOLERANCE_PX,
  };
}

/** Маска затухания по краям; `undefined`, когда затухать нечему. */
export function edgeFadeMask(fade: EdgeFade): string | undefined {
  if (!fade.left && !fade.right) return undefined;
  const stops = [
    fade.left ? `transparent, black ${String(EDGE_FADE_PX)}px` : undefined,
    fade.right ? `black calc(100% - ${String(EDGE_FADE_PX)}px), transparent` : undefined,
  ].filter((stop) => stop !== undefined);
  return `linear-gradient(to right, ${stops.join(", ")})`;
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
