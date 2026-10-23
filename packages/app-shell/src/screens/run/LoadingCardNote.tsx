import type { ReactNode } from "react";
import { t } from "../../i18n";
import "../../i18n/loading";
import { GameGlyph, type Glyph } from "../game-glyphs";
import { cardKey, type LoadingCard } from "./loading-cards";

/**
 * Знаки карточек — свои, языком значков мира (`game-glyphs.tsx`): свеча у
 * совета, свиток у предания. Общий набор иконок сюда не тянется — чанк
 * карточки остаётся словарём с разметкой.
 */
const CARD_GLYPHS: Record<LoadingCard["kind"], Glyph> = {
  tip: [
    ["f", "M12 2.5c1.5 1.6 2.8 3 2.8 5a2.8 2.8 0 0 1-5.6 0c0-1.3.6-2.1 1.3-2.7 0 .9.4 1.6 1 1.8-.1-1.6.1-2.8.5-4.1z"],
    ["f", "M8.5 12.5h7v8h-7z"],
    ["s", "M6 20.5h12"],
  ],
  lore: [
    ["f", "M6.5 4.5h11v15h-11z"],
    ["s3", "M4.5 3.5h15M4.5 20.5h15"],
    ["s", "M9.5 9h5M9.5 12.5h5M9.5 16h3"],
  ],
};

/**
 * Карточка экрана загрузки забега: «Совет» по игре — жаром очага, «Предание»
 * о мире — бирюзой оберегов и светлым текстом: его читают, а не пробегают.
 * Смена карточки проявляет новую заново (`key`).
 */
export function LoadingCardNote(props: { card: LoadingCard }): ReactNode {
  const key = cardKey(props.card);
  const lore = props.card.kind === "lore";
  const tone = lore ? "text-secondary" : "text-accent";
  return (
    <p key={key} className="surface-card flex animate-fade-in items-start gap-2 rounded-lg p-3 text-left text-xs text-text-muted">
      <GameGlyph glyph={CARD_GLYPHS[props.card.kind]} size={18} className={`shrink-0 ${tone}`} />
      <span>
        <span className={`mb-0.5 block font-display font-bold ${tone}`}>{t(`run.card.${props.card.kind}`)}</span>
        <span className={lore ? "text-text" : undefined}>{t(key)}</span>
      </span>
    </p>
  );
}
