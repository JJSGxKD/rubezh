import type { ReactNode } from "react";
import { ArrowDownUp, Combine, Footprints, Gem, Hand, Heart, Ribbon, Sword, Swords } from "lucide-react";
import {
  ArmorIcon,
  Button,
  ContentColumn,
  PageTitle,
  Screen,
  SectionTitle,
  StubNotice,
} from "../../design-system/components";
import { formatNumber, t } from "../../i18n";

/**
 * «Арсенал» — снаряжение персонажа (docs/10-progression-and-ladder.md §2).
 *
 * Заглушка, нарисованная как будущий раздел: персонаж в центре, шесть слотов
 * снаряжения вокруг, суммарные атака и здоровье, инвентарь с редкостью.
 * Предметы и числа — пример, а не баланс: снаряжение появится вместе с
 * прогрессией между забегами. Редкость различается и цветом, и подписью —
 * одним цветом она не передаётся (docs/27-design-system-and-app-shell.md §4.4).
 *
 * Сундуков со случайным снаряжением за деньги не будет: снаряжение — за игру
 * или конкретный предмет по фиксированной цене (docs/03-notes-and-risks.md).
 */

type Rarity = "common" | "rare" | "epic" | "legendary";
type SlotKind = "weapon" | "amulet" | "gloves" | "armor" | "belt" | "boots";

interface ExampleItem {
  slot: SlotKind;
  rarity: Rarity;
  level: number;
  attack: number;
  hp: number;
}

const RARITY_TONE: Record<Rarity, { tile: string; text: string }> = {
  common: { tile: "bg-success/15 text-success ring-success/40", text: "text-success" },
  rare: { tile: "bg-info/15 text-info ring-info/50", text: "text-info" },
  epic: { tile: "bg-passive/15 text-passive ring-passive/50", text: "text-passive" },
  legendary: { tile: "bg-elite/15 text-elite ring-elite/60", text: "text-elite" },
};

const RARITIES: readonly Rarity[] = ["common", "rare", "epic", "legendary"];

const SLOT_ICONS: Record<SlotKind, (size: number) => ReactNode> = {
  weapon: (size) => <Sword size={size} aria-hidden="true" />,
  amulet: (size) => <Gem size={size} aria-hidden="true" />,
  gloves: (size) => <Hand size={size} aria-hidden="true" />,
  armor: (size) => <ArmorIcon size={size} />,
  belt: (size) => <Ribbon size={size} aria-hidden="true" />,
  boots: (size) => <Footprints size={size} aria-hidden="true" />,
};

/** Надетое: слева атакующая половина, справа защитная — как в жанре привыкли. */
const EQUIPPED: Record<SlotKind, ExampleItem> = {
  weapon: { slot: "weapon", rarity: "rare", level: 24, attack: 820, hp: 0 },
  amulet: { slot: "amulet", rarity: "epic", level: 21, attack: 310, hp: 0 },
  gloves: { slot: "gloves", rarity: "epic", level: 21, attack: 245, hp: 0 },
  armor: { slot: "armor", rarity: "rare", level: 24, attack: 0, hp: 2100 },
  belt: { slot: "belt", rarity: "epic", level: 21, attack: 0, hp: 1520 },
  boots: { slot: "boots", rarity: "epic", level: 23, attack: 0, hp: 1412 },
};

const LEFT_SLOTS: readonly SlotKind[] = ["weapon", "amulet", "gloves"];
const RIGHT_SLOTS: readonly SlotKind[] = ["armor", "belt", "boots"];

const INVENTORY: readonly ExampleItem[] = [
  { slot: "armor", rarity: "rare", level: 1, attack: 0, hp: 0 },
  { slot: "amulet", rarity: "rare", level: 10, attack: 0, hp: 0 },
  { slot: "belt", rarity: "rare", level: 7, attack: 0, hp: 0 },
  { slot: "gloves", rarity: "rare", level: 9, attack: 0, hp: 0 },
  { slot: "boots", rarity: "rare", level: 1, attack: 0, hp: 0 },
  { slot: "weapon", rarity: "epic", level: 3, attack: 0, hp: 0 },
  { slot: "amulet", rarity: "legendary", level: 1, attack: 0, hp: 0 },
  { slot: "weapon", rarity: "common", level: 1, attack: 0, hp: 0 },
  { slot: "armor", rarity: "common", level: 1, attack: 0, hp: 0 },
  { slot: "gloves", rarity: "common", level: 1, attack: 0, hp: 0 },
  { slot: "boots", rarity: "common", level: 1, attack: 0, hp: 0 },
  { slot: "belt", rarity: "common", level: 1, attack: 0, hp: 0 },
  { slot: "weapon", rarity: "common", level: 1, attack: 0, hp: 0 },
  { slot: "armor", rarity: "common", level: 1, attack: 0, hp: 0 },
  { slot: "amulet", rarity: "common", level: 1, attack: 0, hp: 0 },
];

export function ArsenalScreen(): ReactNode {
  const items = Object.values(EQUIPPED);
  const attack = items.reduce((sum, item) => sum + item.attack, 0);
  const hp = items.reduce((sum, item) => sum + item.hp, 0);

  return (
    <Screen>
      <ContentColumn>
        <PageTitle>{t("arsenal.title")}</PageTitle>
        <StubNotice text={t("arsenal.stub")} />

        <div className="mt-4 grid grid-cols-2 gap-2">
          <StatChip icon={<Swords size={18} aria-hidden="true" />} label={t("arsenal.attack")} value={attack} tone="weapon" />
          <StatChip icon={<Heart size={18} aria-hidden="true" />} label={t("arsenal.hp")} value={hp} tone="hp" />
        </div>

        <div className="surface-card relative mt-3 grid grid-cols-[auto_1fr_auto] items-center gap-3 overflow-hidden rounded-xl p-3">
          <span aria-hidden="true" className="halo-accent pointer-events-none absolute inset-x-8 top-1/4 bottom-0 opacity-40" />
          <div className="relative grid gap-3">
            {LEFT_SLOTS.map((slot) => (
              <EquipSlot key={slot} item={EQUIPPED[slot]} />
            ))}
          </div>
          <div className="relative flex justify-center">
            <HeroFigure />
          </div>
          <div className="relative grid gap-3">
            {RIGHT_SLOTS.map((slot) => (
              <EquipSlot key={slot} item={EQUIPPED[slot]} />
            ))}
          </div>
        </div>

        <SectionTitle>{t("arsenal.inventory")}</SectionTitle>
        <div className="mb-3 grid grid-cols-2 gap-2">
          <Button variant="secondary" block disabled>
            <ArrowDownUp size={18} aria-hidden="true" />
            {t("arsenal.sort")}
          </Button>
          <Button variant="secondary" block disabled>
            <Combine size={18} aria-hidden="true" />
            {t("arsenal.merge")}
          </Button>
        </div>

        <ul className="grid grid-cols-5 gap-2">
          {INVENTORY.map((item, index) => (
            <li key={index}>
              <ItemTile item={item} />
            </li>
          ))}
        </ul>

        <ul className="mt-4 flex flex-wrap justify-center gap-x-3 gap-y-1">
          {RARITIES.map((rarity) => (
            <li key={rarity} className={`inline-flex items-center gap-1 text-xs font-semibold ${RARITY_TONE[rarity].text}`}>
              <span aria-hidden="true" className="size-2 rounded-full bg-current" />
              {t(`rarity.${rarity}`)}
            </li>
          ))}
        </ul>
      </ContentColumn>
    </Screen>
  );
}

function StatChip(props: { icon: ReactNode; label: string; value: number; tone: "weapon" | "hp" }): ReactNode {
  return (
    <div className="surface-sunken flex items-center gap-2 rounded-lg px-3 py-2">
      <span className={props.tone === "weapon" ? "text-weapon" : "text-hp"}>{props.icon}</span>
      <span className="text-xs text-text-muted">{props.label}</span>
      <span className="ml-auto font-display text-lg font-bold tabular-nums text-text">{formatNumber(props.value)}</span>
    </div>
  );
}

/** Слот снаряжения: значок предмета на подложке его редкости и уровень. */
function EquipSlot(props: { item: ExampleItem }): ReactNode {
  const { item } = props;
  const label = `${t(`arsenal.slot.${item.slot}`)} · ${t(`rarity.${item.rarity}`)} · ${t("arsenal.level", { level: item.level })}`;

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`relative inline-flex size-16 items-center justify-center rounded-lg ring-2 ${RARITY_TONE[item.rarity].tile}`}
    >
      {SLOT_ICONS[item.slot](28)}
      <span className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-pill bg-bg/90 px-1.5 font-display text-xs font-bold whitespace-nowrap tabular-nums text-text">
        {t("arsenal.level", { level: item.level })}
      </span>
    </span>
  );
}

function ItemTile(props: { item: ExampleItem }): ReactNode {
  const { item } = props;
  const label = `${t(`arsenal.slot.${item.slot}`)} · ${t(`rarity.${item.rarity}`)}`;

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`relative flex aspect-square w-full items-center justify-center rounded-md ring-1 ${RARITY_TONE[item.rarity].tile}`}
    >
      {SLOT_ICONS[item.slot](22)}
      <span className="absolute right-1 bottom-0.5 font-display text-xs font-bold tabular-nums text-text">
        {item.level}
      </span>
    </span>
  );
}

/**
 * Персонаж в центре — силуэт из фигур, пока нет ассетов. Цвета — токены через
 * `currentColor`: смена стиля не требует править рисунок.
 */
function HeroFigure(): ReactNode {
  return (
    <svg viewBox="0 0 120 160" className="h-44 w-auto animate-float" aria-hidden="true">
      <ellipse cx="60" cy="150" rx="38" ry="7" className="fill-current text-bg" opacity="0.6" />
      <path d="M30 70 Q60 60 90 70 L98 140 Q60 150 22 140 Z" className="fill-current text-accent-edge" />
      <path d="M36 72 Q60 64 84 72 L88 132 Q60 140 32 132 Z" className="fill-current text-surface-raised" />
      <path d="M60 68 V136" strokeWidth="3" className="stroke-current text-border-strong" />
      <circle cx="60" cy="42" r="28" className="fill-current text-surface-raised" />
      <path d="M36 38 Q60 22 84 38 L84 48 L36 48 Z" className="fill-current text-info" />
      <rect x="44" y="52" width="10" height="6" rx="2" className="fill-current text-text" />
      <rect x="66" y="52" width="10" height="6" rx="2" className="fill-current text-text" />
      <path d="M90 90 L112 66" strokeWidth="7" strokeLinecap="round" className="stroke-current text-weapon" />
    </svg>
  );
}
