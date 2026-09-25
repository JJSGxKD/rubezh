import type { ReactNode } from "react";
import { Crosshair, Shield, Swords, Wind } from "lucide-react";
import { PASSIVE_CATEGORIES, type PassiveCategory } from "@bh/shared-types";
import { LOADOUT_LIMITS, PASSIVES, type RunSlotState } from "@bh/core-game";
import { t } from "../../i18n";
import "../../i18n/run";

/**
 * Занятые слоты набора над выбором улучшения: «Оружие 2/3, Атака 1/2…».
 * Слоты пассивок делятся по категориям, и без этой строки игрок не понял бы,
 * почему «Живучесть» больше не предлагают, — слот защиты уже занят бронёй.
 */
const CATEGORY_ICONS: Record<PassiveCategory, ReactNode> = {
  attack: <Crosshair size={14} aria-hidden="true" />,
  defense: <Shield size={14} aria-hidden="true" />,
  mobility: <Wind size={14} aria-hidden="true" />,
};

export function passiveCategoryOf(id: string): PassiveCategory | null {
  return PASSIVES.find((passive) => passive.id === id)?.category ?? null;
}

export function SlotSummary(props: {
  weapons: readonly RunSlotState[];
  passives: readonly RunSlotState[];
  /** ещё одна плашка в тот же ряд — например, сколько выборов ждёт */
  extra?: ReactNode;
}): ReactNode {
  const used: Record<PassiveCategory, number> = { attack: 0, defense: 0, mobility: 0 };
  for (const slot of props.passives) {
    const category = passiveCategoryOf(slot.id);
    if (category !== null) used[category]++;
  }

  return (
    <ul className="flex flex-wrap justify-center gap-1.5" aria-label={t("run.slots")}>
      <SlotChip
        icon={<Swords size={14} aria-hidden="true" />}
        label={t("run.slots.weapons")}
        used={props.weapons.length}
        limit={LOADOUT_LIMITS.weapons}
        tone="weapon"
      />
      {PASSIVE_CATEGORIES.map((category) => (
        <SlotChip
          key={category}
          icon={CATEGORY_ICONS[category]}
          label={t(`passive.category.${category}`)}
          used={used[category]}
          limit={LOADOUT_LIMITS.passives[category]}
          tone="passive"
        />
      ))}
      {props.extra === undefined ? null : <li className="inline-flex flex-wrap gap-1.5">{props.extra}</li>}
    </ul>
  );
}

/** Категория пассивки подписью: значок и имя — не только цвет (§4.4). */
export function CategoryLabel(props: { category: PassiveCategory }): ReactNode {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-text-muted">
      {CATEGORY_ICONS[props.category]}
      {t(`passive.category.${props.category}`)}
    </span>
  );
}

function SlotChip(props: {
  icon: ReactNode;
  label: string;
  used: number;
  limit: number;
  tone: "weapon" | "passive";
}): ReactNode {
  const full = props.used >= props.limit;

  return (
    <li
      className={[
        "surface-sunken inline-flex items-center gap-1 rounded-pill px-2 py-0.5 font-display text-xs font-semibold tabular-nums",
        full ? "text-text-disabled" : props.tone === "weapon" ? "text-weapon" : "text-passive",
      ].join(" ")}
    >
      {props.icon}
      <span className={full ? "text-text-disabled" : "text-text"}>{props.label}</span>
      <span>
        {props.used}/{props.limit}
      </span>
    </li>
  );
}
