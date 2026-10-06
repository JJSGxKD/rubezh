import type { ReactNode } from "react";
import { SectionTitle } from "../../design-system/components";
import { hasTranslation, t } from "../../i18n";
import "../../i18n/boosts";
import { boostIcon } from "../boost-icons";

/**
 * Бусты забега на экране (docs/35-stage4-plan.md §3.5): купленное перед боем
 * должно быть видно в бою, иначе игрок не верит, что заплатил не зря.
 *
 * Отдельным чанком: значки и тексты бустов нужны только забегу с бустами, а
 * у интерфейса забега свой бюджет (docs/27-design-system-and-app-shell.md §3.4).
 */

function boostName(id: string): string {
  const key = `boost.${id}.name`;
  return hasTranslation(key) ? t(key) : id;
}

/**
 * Плашки бустов в ряду набора внизу HUD — рамкой акцента, а не цветом оружия
 * или пассивки: буст не прокачивается, уровня у него нет. Первые секунды
 * забега — с именами: игрок видит, что купленное включилось.
 */
export function BoostSlots(props: { ids: readonly string[]; named: boolean }): ReactNode {
  return props.ids.map((id) => {
    const Icon = boostIcon(id);
    const name = boostName(id);
    return (
      <span
        key={`b-${id}`}
        role="img"
        aria-label={t("boosts.run.slot", { name })}
        className="inline-flex items-center gap-1 rounded-sm border border-accent/40 bg-bg/70 px-1.5 py-0.5 font-display text-xs font-bold text-accent"
      >
        <Icon size={14} aria-hidden="true" />
        {props.named ? <span className="animate-fade-in text-text">{name}</span> : null}
      </span>
    );
  });
}

/** Бусты в листе «Характеристики»: что каждый делает — тем же текстом, что при покупке. */
export function BoostList(props: { ids: readonly string[] }): ReactNode {
  return (
    <section>
      <SectionTitle>{t("boosts.run.title")}</SectionTitle>
      <ul className="surface-sunken grid gap-2 rounded-md px-3 py-2">
        {props.ids.map((id) => {
          const Icon = boostIcon(id);
          const description = `boost.${id}.description`;
          return (
            <li key={id} className="flex items-start gap-2 text-sm">
              <Icon size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
              <span className="min-w-0">
                <span className="font-display font-semibold text-text">{boostName(id)}</span>
                {hasTranslation(description) ? <span className="block text-xs text-text-muted">{t(description)}</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
