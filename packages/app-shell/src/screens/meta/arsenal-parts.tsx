import type { ReactNode } from "react";
import { Footprints, Gem, Hand, Ribbon, Sword } from "lucide-react";
import { ArmorIcon } from "../../design-system/components";
import { CoinIcon } from "../../design-system/components/CurrencyIcons";
import { formatDecimal, formatNumber, hasTranslation, t } from "../../i18n";
import type { ItemCost, ItemView } from "../../state/items-api";

/**
 * Общие части арсенала: тон редкости, значок слота, плитка предмета, подписи
 * свойств и цен. Редкость различается и цветом, и подписью — одним цветом
 * она не передаётся (docs/27-design-system-and-app-shell.md §4.4).
 *
 * Слот, редкость и свойство приходят строками: незнакомое от сервера новее
 * клиента рисуется нейтрально, а не роняет экран.
 */

export const SLOTS = ["weapon", "amulet", "gloves", "armor", "belt", "boots"] as const;
export const LEFT_SLOTS = ["weapon", "amulet", "gloves"] as const;
export const RIGHT_SLOTS = ["armor", "belt", "boots"] as const;

/** Порядок редкостей — от младшей к старшей: по нему сортировка и легенда. */
export const RARITIES = ["common", "uncommon", "rare", "epic", "legendary", "mythic"] as const;

interface Tone {
  tile: string;
  text: string;
}

const NEUTRAL: Tone = { tile: "bg-surface-raised text-text-muted ring-border-strong", text: "text-text-muted" };

const RARITY_TONE: Record<string, Tone> = {
  common: NEUTRAL,
  uncommon: { tile: "bg-success/15 text-success ring-success/40", text: "text-success" },
  rare: { tile: "bg-info/15 text-info ring-info/50", text: "text-info" },
  epic: { tile: "bg-passive/15 text-passive ring-passive/50", text: "text-passive" },
  legendary: { tile: "bg-elite/15 text-elite ring-elite/60", text: "text-elite" },
  mythic: { tile: "bg-hp/15 text-hp ring-hp/60", text: "text-hp" },
};

export function toneOf(rarity: string): Tone {
  return RARITY_TONE[rarity] ?? NEUTRAL;
}

export function rarityRank(rarity: string): number {
  return (RARITIES as readonly string[]).indexOf(rarity);
}

const SLOT_ICONS: Record<string, (size: number) => ReactNode> = {
  weapon: (size) => <Sword size={size} aria-hidden="true" />,
  amulet: (size) => <Gem size={size} aria-hidden="true" />,
  gloves: (size) => <Hand size={size} aria-hidden="true" />,
  armor: (size) => <ArmorIcon size={size} />,
  belt: (size) => <Ribbon size={size} aria-hidden="true" />,
  boots: (size) => <Footprints size={size} aria-hidden="true" />,
};

export function slotIcon(slot: string, size: number): ReactNode {
  return (SLOT_ICONS[slot] ?? SLOT_ICONS.weapon)?.(size) ?? null;
}

export function slotName(slot: string): string {
  const key = `arsenal.slot.${slot}`;
  return hasTranslation(key) ? t(key) : slot;
}

export function rarityName(rarity: string): string {
  const key = `rarity.${rarity}`;
  return hasTranslation(key) ? t(key) : rarity;
}

export function statName(stat: string): string {
  const key = `item.stat.${stat}`;
  return hasTranslation(key) ? t(key) : stat;
}

/** Здоровье, восстановление и броня — числом, остальное — прибавкой в процентах. */
const FLAT_STATS: ReadonlySet<string> = new Set(["maxHp", "regenPerSec", "armor"]);

export function statValue(stat: string, value: number): string {
  return FLAT_STATS.has(stat) ? `+${formatDecimal(value, 1)}` : `+${formatDecimal(value * 100, 1)}%`;
}

export function itemLabel(item: Pick<ItemView, "slot" | "rarity" | "level">): string {
  return `${slotName(item.slot)} · ${rarityName(item.rarity)} · ${t("arsenal.level", { level: item.level })}`;
}

/** Цена: монеты значком, осколки — точкой цвета их редкости. */
export function CostLabel(props: { cost: ItemCost; rarity: string }): ReactNode {
  return (
    <span className="inline-flex items-center gap-2 tabular-nums">
      {props.cost.coins > 0 ? (
        <span className="inline-flex items-center gap-1">
          <CoinIcon size={14} />
          {formatNumber(props.cost.coins)}
        </span>
      ) : null}
      {props.cost.shards > 0 ? (
        <span className={`inline-flex items-center gap-1 ${toneOf(props.rarity).text}`} title={t("arsenal.shards")}>
          <span aria-hidden="true" className="size-2 rotate-45 bg-current" />
          <span className="text-text">{formatNumber(props.cost.shards)}</span>
          <span className="sr-only">{t("arsenal.shards")}</span>
        </span>
      ) : null}
    </span>
  );
}

/** Слот снаряжения вокруг персонажа: предмет или пустое место под него. */
export function EquipSlot(props: { slot: string; item: ItemView | undefined; onOpen: (item: ItemView) => void }): ReactNode {
  const { item } = props;
  if (item === undefined) {
    return (
      <span
        role="img"
        aria-label={t("arsenal.slot.empty", { slot: slotName(props.slot) })}
        className="inline-flex size-16 items-center justify-center rounded-lg border-2 border-dashed border-border-strong text-text-muted/60"
      >
        {slotIcon(props.slot, 26)}
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-label={itemLabel(item)}
      onClick={() => props.onOpen(item)}
      className={`relative inline-flex size-16 items-center justify-center rounded-lg ring-2 transition-transform active:scale-95 ${toneOf(item.rarity).tile}`}
    >
      {slotIcon(item.slot, 28)}
      <span className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-pill bg-bg/90 px-1.5 font-display text-xs font-bold whitespace-nowrap tabular-nums text-text">
        {t("arsenal.level", { level: item.level })}
      </span>
    </button>
  );
}

/** Плитка инвентаря; в режиме объединения — с отметкой выбора. */
export function ItemTile(props: { item: ItemView; selected: boolean; dimmed: boolean; onPress: (item: ItemView) => void }): ReactNode {
  const { item } = props;
  return (
    <button
      type="button"
      aria-label={itemLabel(item)}
      aria-pressed={props.selected}
      onClick={() => props.onPress(item)}
      className={[
        "relative flex aspect-square w-full items-center justify-center rounded-md transition-[transform,opacity] active:scale-95",
        toneOf(item.rarity).tile,
        props.selected ? "ring-2 ring-accent" : "ring-1",
        props.dimmed ? "opacity-40" : "opacity-100",
      ].join(" ")}
    >
      {slotIcon(item.slot, 22)}
      <span className="absolute right-1 bottom-0.5 font-display text-xs font-bold tabular-nums text-text">{item.level}</span>
      {props.selected ? <span aria-hidden="true" className="absolute top-1 left-1 size-2 rounded-full bg-accent" /> : null}
    </button>
  );
}
