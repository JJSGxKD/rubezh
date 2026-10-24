import type { ReactNode } from "react";
import type { StatusElement } from "@bh/shared-types";
import { ELEMENT_TONE, STATUS_TONE_COLORS } from "@bh/core-game";
import { ELEMENT_GLYPHS, GameGlyph } from "./game-glyphs";

/**
 * Знак стихии — формой и цветом (design/art/direction-v2.md §4.5): тем же
 * цветом мерцает враг в её состоянии на канве, той же формой стоит знак над
 * спрайтом. Один компонент на гайдбук, забег и задания, чтобы «огонь» везде
 * выглядел одинаково; форма не даёт спутать огонь с ядом тому, кто плохо
 * различает цвета.
 */
export function elementColor(element: StatusElement): string {
  const color = STATUS_TONE_COLORS[ELEMENT_TONE[element]] ?? 0xffffff;
  return `#${color.toString(16).padStart(6, "0")}`;
}

export function ElementMark(props: { element: StatusElement; size: number }): ReactNode {
  return (
    <span className="inline-flex shrink-0" style={{ color: elementColor(props.element) }}>
      <GameGlyph glyph={ELEMENT_GLYPHS[props.element]} size={props.size} />
    </span>
  );
}
