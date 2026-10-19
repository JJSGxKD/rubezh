import type { CSSProperties, ReactNode } from "react";

/**
 * Срезанный угол с рамкой по срезу — «подпись» направления «Сумеречный рубеж»
 * (design/README.md, «Срезанный угол»): им выделено главное на экране, а не
 * всё подряд. Экраны не повторяют приём руками, а включают его свойством `cut`
 * у `Card`, `Button` и `Modal`.
 *
 * Два слоя одного многоугольника: внешний — цвет рамки, внутренний (первый
 * ребёнок) — заливка поверхности с отступом на толщину рамки. Срезаны левый
 * верхний и правый нижний углы. Краски и геометрия — в `tokens.css`
 * (`cut-frame`, `cut-fill`, `cut-<тон>`).
 */
export type CutTone = "card" | "card-selected" | "panel" | "primary" | "stars";

/** `md` — карточки и окна, `sm` — кнопки: размеры среза берутся из токенов. */
export type CutSize = "sm" | "md";

const CUT_SIZE: Record<CutSize, string> = { sm: "var(--cut-sm)", md: "var(--cut-md)" };

/** Классы целиком, а не `cut-${tone}`: Tailwind находит утилиты по буквальным именам в исходниках. */
const TONE_CLASS: Record<CutTone, string> = {
  card: "cut-card",
  "card-selected": "cut-card-selected",
  panel: "cut-panel",
  primary: "cut-primary",
  stars: "cut-stars",
};

export interface CutFrameProps {
  tone: CutTone;
  size: CutSize;
  className?: string;
  children: ReactNode;
}

export function CutFrame(props: CutFrameProps): ReactNode {
  const style = { "--cut": CUT_SIZE[props.size] } as CSSProperties;
  const className = ["cut-frame", TONE_CLASS[props.tone], props.className ?? ""].filter((name) => name !== "").join(" ");

  return (
    <div className={className} style={style}>
      <span aria-hidden="true" className="cut-fill" />
      {props.children}
    </div>
  );
}
