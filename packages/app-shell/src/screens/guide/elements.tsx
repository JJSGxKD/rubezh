import type { ReactNode } from "react";
import type { EnemyDef, StatusElement } from "@bh/shared-types";
import { t } from "../../i18n";
import { ElementMark } from "../element-mark";
import { enemyAttackElement, enemyResists, weaponElements } from "./guide-data";

/**
 * Стихии в гайдбуке (docs/35-stage4-plan.md, WP6): что делает каждая, у кого
 * какая стойкость, какая стихия у оружия. Цвет стихии — тот же, каким на поле
 * мерцает враг в её состоянии: прочитав «огонь», игрок узнаёт горящего.
 */

/** Состояния стихий, которые есть у оружия, — для раздела основ. */
export function ElementList(): ReactNode {
  return (
    <ul className="grid gap-2">
      {weaponElements().map((element) => (
        <li key={element} className="surface-sunken flex items-start gap-3 rounded-md px-3 py-2">
          <span className="mt-1">
            <ElementMark element={element} size={14} />
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

/** Стихия на карточке оружия — знак и имя. */
export function ElementTag(props: { element: StatusElement }): ReactNode {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-text">
      <ElementMark element={props.element} size={12} />
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
          <ElementMark element={element} size={12} />
          {t(`guide.element.${element}`).toLowerCase()}
        </span>
      ))}
    </span>
  );
}
