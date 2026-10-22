import type { ReactNode } from "react";
import { Sparkles } from "lucide-react";
import { BOOST_GLYPHS, GameGlyph } from "./game-glyphs";

/**
 * Значки бустов — общие у выбора перед забегом и у плашек в забеге: буст,
 * купленный с топором, в забеге тоже с топором. Знаки — свои, тем же языком,
 * что у оружия и навыков (`game-glyphs.tsx`, design/art/direction-v2.md §4.5).
 * Соответствие — в оболочке, а не в контенте: буст без значка получает общий,
 * и геймдизайнер не ждёт правки интерфейса (как у оружия, `item-icons.tsx`).
 */
export type BoostIcon = (props: { size: number; className?: string; "aria-hidden"?: "true" }) => ReactNode;

/** Общий значок — у буста, которому своего знака ещё не нарисовали. */
export const BOOST_FALLBACK: BoostIcon = (props) => <Sparkles size={props.size} className={props.className} aria-hidden="true" />;

// Компоненты созданы один раз: React не пересоздаёт значок на каждой перерисовке.
const ICONS = new Map<string, BoostIcon>(
  Object.entries(BOOST_GLYPHS).map(([id, glyph]) => [id, (props) => <GameGlyph glyph={glyph} size={props.size} className={props.className} />]),
);

export function boostIcon(id: string): BoostIcon {
  return ICONS.get(id) ?? BOOST_FALLBACK;
}
