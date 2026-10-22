import type { ReactNode } from "react";
import {
  Anvil,
  BicepsFlexed,
  Biohazard,
  Bug,
  CloudHail,
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
  Rocket,
  Shield,
  Slice,
  Snowflake,
  Sparkles,
  Swords,
  Tornado,
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
  // Эволюции (tasks/T-0103): у каждой свой значок, запасной «искры» их не различал бы.
  starfall: Sparkles,
  tempest: Tornado,
  blade_whirl: Swords,
  frost_crown: Snowflake,
  forge: Anvil,
  viper: Biohazard,
  // «Метеор» (T-0118): камень с неба — ракета со следом; «Ливень» — градовая туча.
  // Flame занят «Очагом», Sparkles — «Звездопадом» и запасным значком.
  meteor: Rocket,
  fire_rain: CloudHail,
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

/** Есть ли у оружия свой значок, а не запасной. */
export function hasOwnWeaponIcon(id: string): boolean {
  return WEAPON_ICONS[id] !== undefined;
}

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

const MEDALLION_RING: Record<ItemKind, string> = {
  weapon: "ring-weapon text-weapon",
  passive: "ring-passive text-passive",
  heal: "ring-hp text-hp",
};

/**
 * Значок предмета медальоном — язык окон наград v2
 * (design/art/direction-v2.md §4.4): круг с кольцом цвета вида и светом изнутри,
 * как в окне сундука. Плитка (`ItemTile`) остаётся там, где предметы идут
 * списком и стопкой.
 */
export function ItemMedallion(props: { kind: ItemKind; id: string }): ReactNode {
  return (
    <span
      className={`relative inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-sunken ring-2 ${MEDALLION_RING[props.kind]}`}
      style={{ backgroundImage: "radial-gradient(closest-side, color-mix(in oklab, currentColor 22%, transparent), transparent)" }}
    >
      <ItemIcon kind={props.kind} id={props.id} size={18} />
    </span>
  );
}
