import type { ReactNode } from "react";
import { Anvil, Biohazard, CloudHail, Rocket, Snowflake, Sparkles, Swords, Tornado, type LucideIcon } from "lucide-react";
import { GameGlyph, HEAL_GLYPH, PASSIVE_GLYPHS, WEAPON_GLYPHS } from "./game-glyphs";

/**
 * Значки оружия и пассивок — свои (`game-glyphs.tsx`, design/art/direction-v2.md
 * §4.5). Соответствие живёт в оболочке, а не в контенте: контент не знает,
 * чем его рисуют. Оружие, для которого значка ещё нет, получает общий —
 * геймдизайнер добавляет оружие данными и не обязан ждать правки интерфейса.
 *
 * Значки оружия, которым свой знак ещё не нарисован: эволюции (T-0103) и
 * «Метеор» с «Ливнем» (T-0118) пришли после знаков мира. До своих знаков —
 * значки из набора, у каждой свой: запасной «искры» их не различал бы.
 */
const WEAPON_FALLBACK_ICONS: Readonly<Record<string, LucideIcon>> = {
  starfall: Sparkles,
  tempest: Tornado,
  blade_whirl: Swords,
  frost_crown: Snowflake,
  forge: Anvil,
  viper: Biohazard,
  // Flame занят «Очагом», Sparkles — «Звездопадом» и запасным значком.
  meteor: Rocket,
  fire_rain: CloudHail,
};

/** Есть ли у оружия свой значок, а не запасной. */
export function hasOwnWeaponIcon(id: string): boolean {
  return WEAPON_GLYPHS[id] !== undefined || WEAPON_FALLBACK_ICONS[id] !== undefined;
}

export type ItemKind = "weapon" | "passive" | "heal";

export function ItemIcon(props: { kind: ItemKind; id: string; size?: number }): ReactNode {
  const size = props.size ?? 20;
  const glyph = props.kind === "heal" ? HEAL_GLYPH : (props.kind === "weapon" ? WEAPON_GLYPHS : PASSIVE_GLYPHS)[props.id];
  if (glyph !== undefined) return <GameGlyph glyph={glyph} size={size} />;
  const Fallback = (props.kind === "weapon" ? WEAPON_FALLBACK_ICONS[props.id] : undefined) ?? Sparkles;
  return <Fallback size={size} aria-hidden="true" />;
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
