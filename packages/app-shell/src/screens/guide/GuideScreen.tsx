import { useState, type ReactNode } from "react";
import { Crosshair, Flame, History, Hourglass, Lightbulb, Shuffle, Swords } from "lucide-react";
import { CoinIcon } from "../../design-system/components/CurrencyIcons";
import { PASSIVE_CATEGORIES, type WeaponDef } from "@bh/shared-types";
import { DIFFICULTIES, DROPS, LOADOUT_LIMITS } from "@bh/core-game";
import {
  Badge,
  Card,
  ContentColumn,
  Screen,
  SectionTitle,
  SegmentedControl,
} from "../../design-system/components";
import { formatDecimal, formatDuration, t } from "../../i18n";
import "../../i18n/guide";
import { useNavigation } from "../../state/navigation";
import { ItemIcon, ItemTile } from "../item-icons";
import { formatChange } from "../run/upgrade-format";
import {
  eliteEnemies,
  enemyStages,
  passiveCategories,
  passiveRange,
  regularEnemies,
  speedClass,
  startingWeapons,
  unlockableWeapons,
  weaponElement,
  weaponGrowth,
  type GuideEnemy,
} from "./guide-data";
import { ElementList, ElementTag, ResistLine } from "./elements";
import { EnemyScene, GemRow, PickupIcon, StageMark, WeaponScene } from "./scenes";

/**
 * Гайдбук: основы, враги, оружие и улучшения — с мини-сценами вместо
 * абзацев (docs/27-design-system-and-app-shell.md §6).
 *
 * Числа и состав берутся из контента, а не пишутся текстом: враг, добавленный
 * геймдизайнером, появляется здесь сам. Текстом остаётся только то, чего в
 * данных нет, — что поведение значит для игрока и что с ним делать.
 */
const TABS = ["basics", "enemies", "weapons", "upgrades"] as const;
type GuideTab = (typeof TABS)[number];

export function GuideScreen(): ReactNode {
  const navigation = useNavigation();
  const [tab, setTab] = useState<GuideTab>("basics");

  return (
    <Screen title={t("guide.title")} onBack={() => navigation.pop()}>
      <ContentColumn>
        <div className="mt-1 mb-4">
          <SegmentedControl
            label={t("guide.sections")}
            items={TABS.map((id) => ({ id, label: t(`guide.tab.${id}`) }))}
            activeId={tab}
            onSelect={(id) => setTab(id as GuideTab)}
          />
        </div>
        {/* Ключ — раздел: при переключении лесенка появления проигрывается заново. */}
        <div key={tab} className="grid grid-cols-1 gap-3">
          {tab === "basics" ? <Basics /> : null}
          {tab === "enemies" ? <Enemies /> : null}
          {tab === "weapons" ? <Weapons /> : null}
          {tab === "upgrades" ? <Upgrades /> : null}
        </div>
      </ContentColumn>
    </Screen>
  );
}

function Topic(props: { icon?: ReactNode; title: string; text: string; index: number; children?: ReactNode }): ReactNode {
  return (
    <Card appearIndex={Math.min(props.index, 6)}>
      <div className="flex items-start gap-3">
        {props.icon === undefined ? null : (
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
            {props.icon}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-base font-bold text-text">{props.title}</h2>
          <p className="mt-1 text-sm text-text-muted">{props.text}</p>
        </div>
      </div>
      {props.children === undefined ? null : <div className="mt-3">{props.children}</div>}
    </Card>
  );
}

function Basics(): ReactNode {
  const categories = PASSIVE_CATEGORIES.map((category) => ({
    label: t(`passive.category.${category}`),
    slots: LOADOUT_LIMITS.passives[category],
  }));

  return (
    <>
      <Topic index={0} icon={<Hourglass size={20} />} title={t("guide.basics.goal.title")} text={t("guide.basics.goal.text")} />

      <Topic index={1} icon={<Crosshair size={20} />} title={t("guide.basics.move.title")} text={t("guide.basics.move.text")}>
        <div className="mx-auto max-w-[300px]">
          <WeaponScene behavior="projectile_nearest" label={t("guide.basics.move.title")} />
        </div>
      </Topic>

      <Topic index={2} title={t("guide.basics.xp.title")} text={t("guide.basics.xp.text")}>
        <div className="surface-sunken rounded-md px-3 py-2">
          <GemRow caption={(minValue) => t("guide.basics.xp.gem", { value: minValue })} />
        </div>
      </Topic>

      <Topic index={3} title={t("guide.basics.slots.title")} text={t("guide.basics.slots.text")}>
        <ul className="grid grid-cols-2 gap-2">
          {[{ label: t("run.slots.weapons"), slots: LOADOUT_LIMITS.weapons }, ...categories].map((row) => (
            <li key={row.label} className="surface-sunken flex items-center justify-between gap-2 rounded-md px-3 py-2">
              <span className="truncate text-sm text-text">{row.label}</span>
              <span className="flex shrink-0 gap-1" aria-label={String(row.slots)}>
                {Array.from({ length: row.slots }, (_, index) => (
                  <span key={index} className="h-3 w-4 rounded-sm border border-border-strong bg-surface-raised" />
                ))}
              </span>
            </li>
          ))}
        </ul>
      </Topic>

      <Topic index={4} title={t("guide.basics.pickups.title")} text={t("guide.basics.pickups.rare")}>
        <ul className="grid gap-2">
          <PickupRow id="medkit" text={t("guide.pickup.medkit.text", { percent: Math.round(DROPS.medkits.healRatio * 100) })} />
          <PickupRow id="magnet" text={t("guide.pickup.magnet.text")} />
          <PickupRow
            id="dynamite"
            text={t("guide.pickup.dynamite.text", { percent: Math.round(DROPS.dynamite.eliteHpRatio * 100) })}
          />
        </ul>
      </Topic>

      <Topic index={5} icon={<Lightbulb size={20} />} title={t("guide.basics.signals.title")} text={t("guide.basics.signals.text")}>
        <div className="grid grid-cols-2 gap-2">
          <EnemyScene pattern="dash" elite={false} label={t("guide.pattern.dash.name")} />
          <EnemyScene pattern="exploder" elite={false} label={t("guide.pattern.exploder.name")} />
        </div>
      </Topic>

      <Topic index={6} icon={<Flame size={20} />} title={t("guide.basics.elements.title")} text={t("guide.basics.elements.text")}>
        <ElementList />
      </Topic>

      <Topic index={7} icon={<Swords size={20} />} title={t("guide.basics.difficulty.title")} text={t("guide.basics.difficulty.text")}>
        <ul className="grid gap-2">
          {DIFFICULTIES.map((difficulty) => (
            <li key={difficulty.id} className="surface-sunken rounded-md px-3 py-2">
              <span className="block font-display text-sm font-semibold text-text">{t(difficulty.nameKey)}</span>
              <span className="block text-xs text-text-muted">
                {difficulty.enemyHpMul === 1 && difficulty.enemyDamageMul === 1
                  ? t("guide.difficulty.base")
                  : t("guide.difficulty.stats", {
                      hp: formatDecimal(difficulty.enemyHpMul),
                      damage: formatDecimal(difficulty.enemyDamageMul),
                      spawn: formatDecimal(difficulty.spawnRateMul),
                    })}
              </span>
            </li>
          ))}
        </ul>
      </Topic>

      <Topic index={8} icon={<History size={20} />} title={t("guide.basics.save.title")} text={t("guide.basics.save.text")} />

      <Topic index={9} icon={<CoinIcon size={20} />} title={t("guide.basics.reward.title")} text={t("guide.basics.reward.text")} />
    </>
  );
}

function PickupRow(props: { id: "medkit" | "magnet" | "dynamite"; text: string }): ReactNode {
  return (
    <li className="surface-sunken flex items-center gap-3 rounded-md px-3 py-2">
      <PickupIcon id={props.id} size={36} />
      <span className="min-w-0">
        <span className="block font-display text-sm font-semibold text-text">{t(`guide.pickup.${props.id}.name`)}</span>
        <span className="block text-xs text-text-muted">{props.text}</span>
      </span>
    </li>
  );
}

function Enemies(): ReactNode {
  const regular = regularEnemies();
  const elite = eliteEnemies();

  return (
    <>
      <p className="text-sm text-text-muted">{t("guide.enemies.intro")}</p>
      <SectionTitle>{t("guide.enemies.regular")}</SectionTitle>
      {regular.map((enemy, index) => (
        <EnemyCard key={enemy.def.id} enemy={enemy} index={index} />
      ))}
      <p className="text-xs text-text-muted">{t("guide.enemies.basis")}</p>

      <SectionTitle>{t("guide.enemies.stages")}</SectionTitle>
      <p className="text-sm text-text-muted">{t("guide.enemies.stages.text")}</p>
      <Card>
        <ul className="flex flex-col gap-3">
          {enemyStages().map((stage, index) => (
            <li key={stage.fromSec} className="flex items-center gap-3">
              <StageMark stage={index} />
              <span className="min-w-0">
                <span className="block font-display text-sm font-semibold text-text">
                  {t(stage.nameKey ?? "enemy.stage.base")}
                </span>
                <span className="block text-xs text-text-muted">
                  {index === 0
                    ? t("guide.enemy.stage.first")
                    : t("guide.enemy.stage.from", { time: formatDuration(stage.fromSec) })}
                  {" · "}
                  {t("guide.enemy.stage.stats", {
                    hp: formatDecimal(stage.hpMul, 1),
                    damage: formatDecimal(stage.damageMul, 2),
                    xp: formatDecimal(stage.xpMul, 0),
                  })}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <SectionTitle>{t("guide.enemies.elite")}</SectionTitle>
      <p className="text-sm text-text-muted">{t("guide.enemies.elite.text")}</p>
      {elite.map((enemy, index) => (
        <EnemyCard key={enemy.def.id} enemy={enemy} index={index} />
      ))}
    </>
  );
}

function EnemyCard(props: { enemy: GuideEnemy; index: number }): ReactNode {
  const { def, children } = props.enemy;
  const elite = def.rank !== undefined;
  const name = t(`enemy.${def.id}.name`);

  return (
    <Card appearIndex={Math.min(props.index, 6)}>
      {/* Сцена слева, текст справа: на телефоне так в экран влезает два-три
          врага, а не один. На узком экране сцена уходит наверх. */}
      <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <EnemyScene
          pattern={def.pattern}
          elite={elite}
          label={name}
          {...(children[0] === undefined ? {} : { child: children[0].def.pattern })}
        />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="font-display text-base font-bold text-text">{name}</h3>
            <Badge tone={elite ? "warning" : "muted"}>{t(`guide.pattern.${def.pattern}.name`)}</Badge>
          </div>
          <p className="mt-1 text-sm text-text-muted">{t(`guide.pattern.${def.pattern}.text`)}</p>
          <p className="mt-1.5 text-xs text-text-muted">
            {t("guide.enemy.stats", { hp: def.hp, damage: def.damage, xp: def.xp })} ·{" "}
            {t(`guide.enemy.speed.${speedClass(def.speed)}`).toLowerCase()}
          </p>
          <ResistLine def={def} />
          {children.length === 0 ? null : (
            <p className="mt-1 flex items-center gap-1 text-xs text-text-muted">
              <Shuffle size={12} aria-hidden="true" className="shrink-0" />
              {/* Матрёшка рассыпается смесью — перечисляем всех, кто в ней. */}
              {t("guide.enemy.splits", {
                children: children
                  .map((child) => `${String(child.count)} × ${t(`enemy.${child.def.id}.name`)}`)
                  .join(", "),
              })}
            </p>
          )}
        </div>
      </div>
      <p className="surface-sunken mt-3 flex items-start gap-2 rounded-md px-3 py-2 text-xs text-text">
        <Lightbulb size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
        {t(`guide.pattern.${def.pattern}.tip`)}
      </p>
    </Card>
  );
}

function Weapons(): ReactNode {
  return (
    <>
      <p className="text-sm text-text-muted">{t("guide.weapons.intro")}</p>
      <SectionTitle>{t("guide.weapons.starting")}</SectionTitle>
      {startingWeapons().map((weapon, index) => (
        <WeaponCard key={weapon.id} weapon={weapon} index={index} />
      ))}
      <SectionTitle>{t("guide.weapons.unlockable")}</SectionTitle>
      {unlockableWeapons().map((weapon, index) => (
        <WeaponCard key={weapon.id} weapon={weapon} index={index} />
      ))}
    </>
  );
}

function WeaponCard(props: { weapon: WeaponDef; index: number }): ReactNode {
  const { weapon } = props;
  const name = t(weapon.nameKey);
  const element = weaponElement(weapon);

  return (
    <Card appearIndex={Math.min(props.index, 6)} stripe="weapon">
      <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <WeaponScene behavior={weapon.behavior} label={name} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-weapon">
              <ItemIcon kind="weapon" id={weapon.id} size={16} />
            </span>
            <h3 className="font-display text-base font-bold text-text">{name}</h3>
            {weapon.starting === true ? <Badge tone="weapon">{t("guide.weapon.starting")}</Badge> : null}
            {element === null ? null : <ElementTag element={element} />}
          </div>
          <p className="mt-1 text-sm text-text-muted">{t(`guide.behavior.${weapon.behavior}`)}</p>
        </div>
      </div>
      <div className="surface-sunken mt-3 rounded-md px-3 py-2">
        <p className="mb-1 font-display text-xs font-semibold tracking-wide text-text-muted uppercase">
          {t("guide.weapon.growth", { max: weapon.levels.length })}
        </p>
        <ul className="grid gap-0.5">
          {weaponGrowth(weapon).map((change) => {
            const formatted = formatChange(change);
            return (
              <li key={change.labelKey} className="flex items-baseline justify-between gap-2 text-sm">
                <span className="truncate text-text-muted">{t(change.labelKey)}</span>
                <span className="shrink-0 font-display tabular-nums text-text">
                  {formatted.from} → <span className="text-success">{formatted.to}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}

function Upgrades(): ReactNode {
  return (
    <>
      <p className="text-sm text-text-muted">{t("guide.upgrades.intro")}</p>
      {passiveCategories().map((group) => (
        <section key={group.category} className="grid grid-cols-1 gap-2">
          <SectionTitle>
            {t("guide.upgrades.category", { category: t(`passive.category.${group.category}`), slots: group.slots })}
          </SectionTitle>
          {group.passives.map((passive, index) => {
            const range = passiveRange(passive);
            const formatted = range === null ? null : formatChange(range);
            return (
              <Card key={passive.id} appearIndex={Math.min(index, 6)} stripe="passive">
                <div className="flex items-start gap-3">
                  <ItemTile kind="passive" id={passive.id} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                      <h3 className="font-display text-base font-bold text-text">{t(passive.nameKey)}</h3>
                      <span className="text-xs text-text-muted">
                        {t("guide.upgrades.levels", { count: passive.levels.length })}
                      </span>
                    </div>
                    <p className="text-sm text-text-muted">{t(passive.descriptionKey)}</p>
                    {range === null || formatted === null ? null : (
                      <p className="mt-1 text-xs text-text-muted">
                        {t(range.labelKey)}:{" "}
                        <span className="font-display tabular-nums text-text">
                          {formatted.from} → <span className="text-success">{formatted.to}</span>
                        </span>
                      </p>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </section>
      ))}
      <Topic index={0} icon={<ItemIcon kind="heal" id="" size={20} />} title={t("guide.upgrades.heal.title")} text={t("guide.upgrades.heal.text")} />
    </>
  );
}
