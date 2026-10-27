import type { CSSProperties, ReactNode } from "react";
import { Footprints, Gem, Hand, Ribbon, Sword } from "lucide-react";
import { ArmorIcon } from "../../design-system/components";
import { CoinIcon } from "../../design-system/components/CurrencyIcons";
import { ShardIcon } from "../../design-system/components/ShardIcon";
import { formatDecimal, formatNumber, hasTranslation, t } from "../../i18n";
import type { ItemCost, ItemView } from "../../state/items-api";
import { rarityLook, shineDelayMs } from "./rarity-look";

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
  // Красный — тон опасности: тон здоровья зелёный, и мифическая путалась бы с добротной.
  mythic: { tile: "bg-danger/15 text-danger ring-danger/60", text: "text-danger" },
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

export function statValue(stat: string, value: number, digits = 1): string {
  return FLAT_STATS.has(stat) ? `+${formatDecimal(value, digits)}` : `+${formatDecimal(value * 100, digits)}%`;
}

/**
 * «Было → стало» для строки свойства. Малая прибавка на одном знаке после
 * запятой совпадает с прежней — тогда показываем два знака. Если и на двух
 * одинаково, свойство не меняется: `to: null`, строка показывает одно значение.
 */
export function statChange(stat: string, from: number, to: number): { from: string; to: string | null } {
  for (const digits of [1, 2]) {
    const before = statValue(stat, from, digits);
    const after = statValue(stat, to, digits);
    if (before !== after) return { from: before, to: after };
  }
  return { from: statValue(stat, from), to: null };
}

export function itemLabel(item: Pick<ItemView, "slot" | "rarity" | "level">): string {
  return `${slotName(item.slot)} · ${rarityName(item.rarity)} · ${t("arsenal.level", { level: item.level })}`;
}

/** Цена: монеты значком, осколки — общим значком осколка цвета их редкости. */
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
        <span className="inline-flex items-center gap-1" title={t("arsenal.shards")}>
          <ShardIcon rarity={props.rarity} size={14} />
          <span className="text-text">{formatNumber(props.cost.shards)}</span>
          <span className="sr-only">{t("arsenal.shards")}</span>
        </span>
      ) : null}
    </span>
  );
}

/** Четырёхлучевая искра мифической редкости. */
function Spark(props: { className: string; delayMs: number }): ReactNode {
  return (
    <svg viewBox="0 0 10 10" className={`absolute size-2.5 animate-star-twinkle ${props.className}`} style={{ animationDelay: `-${String(props.delayMs)}ms` }}>
      <path d="M5 0 6 4 10 5 6 6 5 10 4 6 0 5 4 4z" fill="color-mix(in oklab, var(--rarity-tone) 35%, white)" />
    </svg>
  );
}

/**
 * Слои редкости под значком плитки (rarity-look.ts): свет снизу, оправа,
 * блеск, ореол, искры. Плитке нужны `relative isolate` и скругление: слои
 * лежат на `-z-1` и берут скругление через `rounded-[inherit]`. `seed` —
 * ключ предмета: по нему блеск соседних плиток вспыхивает в разное время.
 */
export function RarityGlow(props: { rarity: string; seed: string }): ReactNode {
  const look = rarityLook(props.rarity);
  if (!look.glow) return null;
  const delay = shineDelayMs(props.seed);
  const style = { "--rarity-tone": look.tone } as CSSProperties;
  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-0 -z-1 rounded-[inherit]" style={style}>
      {look.halo ? <span className="absolute inset-0 rounded-[inherit] rarity-halo" /> : null}
      <span className="absolute inset-0 overflow-hidden rounded-[inherit] rarity-glow">
        {look.facets ? <span className="absolute inset-0 rounded-[inherit] rarity-facets" /> : null}
        {look.shine ? (
          <span
            className="absolute inset-y-0 left-0 w-1/2 animate-btn-shine opacity-0"
            style={{
              animationDelay: `-${String(delay)}ms`,
              backgroundImage: "linear-gradient(90deg, transparent, color-mix(in oklab, var(--rarity-tone) 35%, white 30%), transparent)",
            }}
          />
        ) : null}
      </span>
      {look.sparks ? (
        <>
          <Spark className="top-0.5 left-0.5" delayMs={delay} />
          {/* Правый нижний угол занят уровнем плитки — вторая искра слева. */}
          <Spark className="bottom-0.5 left-0.5" delayMs={delay + 1_300} />
        </>
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
      className={`relative isolate inline-flex size-16 items-center justify-center rounded-lg ring-2 transition-transform active:scale-95 ${toneOf(item.rarity).tile}`}
    >
      <RarityGlow rarity={item.rarity} seed={item.itemId} />
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
      aria-label={item.isNew === true ? t("arsenal.item.new", { item: itemLabel(item) }) : itemLabel(item)}
      aria-pressed={props.selected}
      onClick={() => props.onPress(item)}
      className={[
        "relative isolate flex aspect-square w-full items-center justify-center rounded-md transition-[transform,opacity] active:scale-95",
        toneOf(item.rarity).tile,
        props.selected ? "ring-2 ring-accent" : "ring-1",
        props.dimmed ? "opacity-40" : "opacity-100",
      ].join(" ")}
    >
      <RarityGlow rarity={item.rarity} seed={item.itemId} />
      {slotIcon(item.slot, 22)}
      <span className="absolute right-1 bottom-0.5 font-display text-xs font-bold tabular-nums text-text">{item.level}</span>
      {props.selected ? <span aria-hidden="true" className="absolute top-1 left-1 size-2 rounded-full bg-accent" /> : null}
      {/* Новый — лист ещё не открывали: так видно, откуда число на вкладке (Р50). */}
      {item.isNew === true ? <span aria-hidden="true" className="absolute top-1 right-1 size-2 rounded-full bg-danger" /> : null}
    </button>
  );
}
