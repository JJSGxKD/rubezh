import type { ReactNode } from "react";
import type { EnemyDef, StatusElement } from "@bh/shared-types";
import { ELEMENT_TONE, STATUS_TONE_COLORS } from "@bh/core-game";
import { t } from "../../i18n";
import { ELEMENT_GLYPHS, GameGlyph } from "../game-glyphs";
import { enemyAttackElement, enemyResists, weaponElements } from "./guide-data";
import { hex } from "./scenes";

/**
 * Стихии в гайдбуке (docs/35-stage4-plan.md, WP6): что делает каждая, у кого
 * какая стойкость, какая стихия у оружия. Цвет стихии — тот же, каким на поле
 * мерцает враг в её состоянии: прочитав «огонь», игрок узнаёт горящего.
 */

/**
 * Знак стихии — формой и цветом, как над врагом в забеге и на карточке
 * уровня (design/art/direction-v2.md §4.5): кружок различался только цветом.
 */
export function ElementDot(props: { element: StatusElement; size?: number }): ReactNode {
  const size = props.size ?? 12;
  return (
    <span className="inline-flex shrink-0" style={{ color: hex(STATUS_TONE_COLORS[ELEMENT_TONE[props.element]] ?? 0xffffff) }}>
      <GameGlyph glyph={ELEMENT_GLYPHS[props.element]} size={size} />
    </span>
  );
}

/** Состояния стихий, которые есть у оружия, — для раздела основ. */
export function ElementList(): ReactNode {
  return (
    <ul className="grid gap-2">
      {weaponElements().map((element) => (
        <li key={element} className="surface-sunken flex items-start gap-3 rounded-md px-3 py-2">
          <span className="mt-1">
            <ElementDot element={element} size={14} />
          </span>
          <span className="min-w-0">
            <span className="block font-display text-sm font-semibold text-text">{t(`guide.element.${element}`)}</span>
            <span className="block text-xs text-text-muted">{t(`guide.status.${element}`)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Стихия на карточке оружия — цветной кружок и имя. */
export function ElementTag(props: { element: StatusElement }): ReactNode {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-text">
      <ElementDot element={props.element} />
      {t(`guide.element.${props.element}`)}
    </span>
  );
}

/** «Атака: огонь · Стойкость: огонь · Слабость: холод» на карточке врага; у роя строки нет. */
export function ResistLine(props: { def: EnemyDef }): ReactNode {
  const { strong, weak } = enemyResists(props.def);
  const attack = enemyAttackElement(props.def);
  if (strong.length === 0 && weak.length === 0 && attack === null) return null;
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
      {attack === null ? null : <ElementGroup label={t("guide.enemy.attack")} elements={[attack]} />}
      {strong.length === 0 ? null : <ElementGroup label={t("guide.enemy.strong")} elements={strong} />}
      {weak.length === 0 ? null : <ElementGroup label={t("guide.enemy.weak")} elements={weak} />}
    </p>
  );
}

function ElementGroup(props: { label: string; elements: StatusElement[] }): ReactNode {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {props.label}
      {props.elements.map((element) => (
        <span key={element} className="inline-flex items-center gap-1 text-text">
          <ElementDot element={element} />
          {t(`guide.element.${element}`).toLowerCase()}
        </span>
      ))}
    </span>
  );
}
