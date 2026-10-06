import type { ReactNode } from "react";
import {
  Anvil,
  BicepsFlexed,
  Bug,
  CloudLightning,
  Flame,
  Footprints,
  Heart,
  HeartPlus,
  HeartPulse,
  Hourglass,
  Layers,
  Magnet,
  Orbit,
  Radius,
  Shield,
  Slice,
  Sparkles,
  Zap,
  type LucideIcon,
} from "lucide-react";

/**
 * Значки оружия и пассивок — временные, из набора иконок, до своих ассетов
 * (docs/27-design-system-and-app-shell.md §1.4).
 *
 * Соответствие живёт в оболочке, а не в контенте: контент не знает, чем его
 * рисуют. Оружие, для которого значка ещё нет, получает общий — геймдизайнер
 * добавляет оружие данными и не обязан ждать правки интерфейса.
 */
const WEAPON_ICONS: Readonly<Record<string, LucideIcon>> = {
  spark: Zap,
  knife: Slice,
  wardstone: Orbit,
  hearth: Flame,
  storm: CloudLightning,
  sting: Bug,
};

const PASSIVE_ICONS: Readonly<Record<string, LucideIcon>> = {
  might: BicepsFlexed,
  haste: Hourglass,
  reach: Radius,
  volley: Layers,
  swiftness: Footprints,
  vitality: Heart,
  mending: HeartPulse,
  lodestone: Magnet,
  ward: Shield,
  tempering: Anvil,
};

export type ItemKind = "weapon" | "passive" | "heal";

export function ItemIcon(props: { kind: ItemKind; id: string; size?: number }): ReactNode {
  const Icon =
    props.kind === "heal"
      ? HeartPlus
      : ((props.kind === "weapon" ? WEAPON_ICONS : PASSIVE_ICONS)[props.id] ?? Sparkles);
  return <Icon size={props.size ?? 20} aria-hidden="true" />;
}

const TILE_TONE: Record<ItemKind, string> = {
  weapon: "bg-weapon/15 text-weapon",
  passive: "bg-passive/15 text-passive",
  heal: "bg-hp/15 text-hp",
};

/** Значок на цветной плитке: оружие жёлтое, пассивка фиолетовая, лечение зелёное. */
export function ItemTile(props: { kind: ItemKind; id: string; size?: "s" | "m" }): ReactNode {
  if (props.size === "s") {
    // Маленькие плитки ложатся стопкой внахлёст: у полупрозрачной плитки
    // нужна непрозрачная подложка и кромка, иначе соседняя просвечивает.
    return (
      <span className="inline-flex size-8 shrink-0 rounded-md bg-surface ring-2 ring-surface-raised">
        <span
          className={`inline-flex size-full items-center justify-center rounded-md ${TILE_TONE[props.kind]}`}
        >
          <ItemIcon kind={props.kind} id={props.id} size={16} />
        </span>
      </span>
    );
  }
  return (
    <span
      className={`inline-flex size-11 shrink-0 items-center justify-center rounded-md ${TILE_TONE[props.kind]}`}
    >
      <ItemIcon kind={props.kind} id={props.id} size={22} />
    </span>
  );
}
