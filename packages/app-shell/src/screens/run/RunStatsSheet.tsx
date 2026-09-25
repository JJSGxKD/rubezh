import { useState, type ReactNode } from "react";
import type { RunInspection, RunWeaponInspection } from "@bh/core-game";
import { Button, Modal, SegmentedControl } from "../../design-system/components";
import { formatDecimal, formatNumber, hasTranslation, t } from "../../i18n";
import "../../i18n/run";
import { ItemIcon, ItemTile } from "../item-icons";
import { CategoryLabel } from "./SlotSummary";

/**
 * Лист «Характеристики» поверх паузы и выбора улучшения: что сейчас умеет
 * персонаж и каждое оружие (docs/27-design-system-and-app-shell.md §6).
 *
 * Числа — снимок движка на момент открытия: мир стоит, и живое обновление
 * здесь не нужно. Выбор улучшения при этом показывает «было → стало» на
 * карточках, а лист отвечает на вопрос «что у меня уже есть».
 */
const TABS = ["player", "weapons", "passives"] as const;
type Tab = (typeof TABS)[number];

export function RunStatsSheet(props: { inspection: RunInspection; onClose(): void }): ReactNode {
  const [tab, setTab] = useState<Tab>("player");
  const { inspection } = props;

  return (
    <Modal
      title={t("run.stats.title")}
      placement="bottom"
      onDismiss={props.onClose}
      footer={
        <Button variant="ghost" block onClick={props.onClose}>
          {t("app.close")}
        </Button>
      }
    >
      <SegmentedControl
        label={t("run.stats.title")}
        items={TABS.map((id) => ({ id, label: t(`run.stats.tab.${id}`) }))}
        activeId={tab}
        onSelect={(id) => setTab(id as Tab)}
      />
      <div className="mt-3">
        {tab === "player" ? <PlayerStats inspection={inspection} /> : null}
        {tab === "weapons" ? <WeaponStats inspection={inspection} /> : null}
        {tab === "passives" ? <PassiveStats inspection={inspection} /> : null}
      </div>
    </Modal>
  );
}

function Rows(props: { rows: readonly (readonly [string, string])[] }): ReactNode {
  return (
    <dl className="surface-sunken grid gap-1 rounded-md px-3 py-2">
      {props.rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-3 text-sm">
          <dt className="min-w-0 text-text-muted">{label}</dt>
          <dd className="shrink-0 font-display font-semibold tabular-nums text-text">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PlayerStats(props: { inspection: RunInspection }): ReactNode {
  const { player } = props.inspection;
  return (
    <div className="grid gap-2">
      <Rows
        rows={[
          [t("run.stats.hp"), `${formatNumber(player.hp)} / ${formatNumber(player.maxHp)}`],
          [t("run.stats.regen"), t("run.stats.perSec", { value: formatDecimal(player.regenPerSec, 1) })],
          [t("run.stats.armor"), formatDecimal(player.armor, 1)],
          [t("run.stats.moveSpeed"), formatNumber(player.moveSpeed)],
          [t("run.stats.pickupRadius"), formatNumber(player.pickupRadius)],
        ]}
      />
      <Rows
        rows={[
          [t("run.stats.damage"), percent(player.damageMul)],
          [t("run.stats.cooldown"), percent(player.cooldownMul)],
          [t("run.stats.area"), percent(player.areaMul)],
          [t("run.stats.projectileSpeed"), percent(player.projectileSpeedMul)],
          [t("run.stats.extraProjectiles"), signed(player.extraProjectiles)],
        ]}
      />
      <Rows
        rows={[
          [t("run.stats.killed"), formatNumber(props.inspection.enemiesKilled)],
          [t("run.stats.damageTaken"), formatNumber(props.inspection.damageTaken)],
        ]}
      />
    </div>
  );
}

function WeaponStats(props: { inspection: RunInspection }): ReactNode {
  return (
    <ul className="grid gap-2">
      {props.inspection.weapons.map((weapon) => (
        <li key={weapon.id} className="grid gap-2">
          <div className="flex items-center gap-2">
            <span className="text-weapon">
              <ItemIcon kind="weapon" id={weapon.id} size={18} />
            </span>
            <span className="min-w-0 flex-1 truncate font-display text-base font-bold text-text">{t(`weapon.${weapon.id}.name`)}</span>
            <span className="text-xs text-text-muted">{t("run.stats.level", { level: weapon.level, max: weapon.maxLevel })}</span>
          </div>
          <Rows rows={weaponRows(weapon)} />
          <div className="grid gap-1">
            <span className="surface-sunken block h-1.5 overflow-hidden rounded-pill">
              <span
                className="fill-accent block h-full origin-left rounded-pill"
                style={{ transform: `scaleX(${weapon.damageShare})` }}
              />
            </span>
            <span className="text-xs text-text-muted">
              {t("run.stats.dealt", {
                damage: formatNumber(weapon.damageDealt),
                share: Math.round(weapon.damageShare * 100),
                dps: formatNumber(weapon.dps),
              })}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Строки оружия — только осмысленные для его поведения: у ауры нет пробивания. */
function weaponRows(weapon: RunWeaponInspection): [string, string][] {
  const label = (field: string): string => {
    const specific = `upgrade.stat.${weapon.behavior}.${field}`;
    return hasTranslation(specific) ? t(specific) : t(`upgrade.stat.${field}`);
  };
  const rows: [string, string][] = [
    [label("damage"), formatDecimal(weapon.damage, 1)],
    [label("cooldownSec"), formatDecimal(weapon.cooldownSec, 2)],
  ];
  if (weapon.behavior !== "aura") rows.push([label("projectiles"), formatNumber(weapon.projectiles)]);
  if (weapon.pierce > 0) rows.push([label("pierce"), formatNumber(weapon.pierce)]);
  if (weapon.areaRadius > 0) rows.push([label("areaRadius"), formatNumber(weapon.areaRadius)]);
  return rows;
}

function PassiveStats(props: { inspection: RunInspection }): ReactNode {
  if (props.inspection.passives.length === 0) {
    return <p className="surface-sunken rounded-md p-3 text-sm text-text-muted">{t("run.stats.noPassives")}</p>;
  }
  return (
    <ul className="grid gap-2">
      {props.inspection.passives.map((passive) => (
        <li key={passive.id} className="surface-sunken flex items-center gap-3 rounded-md px-3 py-2">
          <ItemTile kind="passive" id={passive.id} size="s" />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2">
              <span className="font-display text-sm font-bold text-text">{t(`passive.${passive.id}.name`)}</span>
              {passive.category === "attack" || passive.category === "defense" || passive.category === "mobility" ? (
                <CategoryLabel category={passive.category} />
              ) : null}
            </span>
            <span className="block text-xs text-text-muted">
              {t(`upgrade.stat.passive.${passive.stat}`)}: {passive.op === "mul" ? percent(passive.value) : signed(passive.value)}
            </span>
          </span>
          <span className="shrink-0 text-xs text-text-muted">{t("run.stats.level", { level: passive.level, max: passive.maxLevel })}</span>
        </li>
      ))}
    </ul>
  );
}

/** Множитель игроку — сдвигом: 1.2 — «+20 %», 0.92 — «−8 %», 1 — «0 %». */
function percent(multiplier: number): string {
  const value = Math.round((multiplier - 1) * 100);
  return `${signed(value)} %`;
}

function signed(value: number): string {
  if (value === 0) return "0";
  return value > 0 ? `+${formatDecimal(value, 1)}` : `−${formatDecimal(-value, 1)}`;
}
