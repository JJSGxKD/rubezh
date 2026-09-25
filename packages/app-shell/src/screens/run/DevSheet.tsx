import { useState, type ReactNode } from "react";
import { ENEMIES, PASSIVES, WEAPONS, type RunDevCommand, type RunDevPickup } from "@bh/core-game";
import { Badge, Button, ListGroup, ListItem, Modal, SegmentedControl } from "../../design-system/components";
import { t } from "../../i18n";
import "../../i18n/run";
import "../../i18n/team";
import { hasCheats, useDevMode, type DevSettings, type DevVisualKey } from "../../state/dev-mode";
import { DAMAGE_MULS, DEV_PRESETS, MOVE_SPEED_MULS, TIME_SCALES, type DevPresetId } from "./dev-presets";
import { useRun } from "../../state/run";

/**
 * Лист режима разработчика (docs/26-stage2-plan.md, WP14): перед забегом — с
 * экрана выбора оружия, в забеге — с паузы. Настройки меняются сразу и
 * запоминаются на устройстве; команды «Мира» доступны только в забеге.
 */
const TABS = ["view", "time", "cheats", "world"] as const;
type Tab = (typeof TABS)[number];

const VISUAL_KEYS: readonly DevVisualKey[] = [
  "techInfo",
  "hitboxes",
  "weaponRadii",
  "pickupRadius",
  "spawnRings",
  "bounds",
  "grid",
  "telegraphs",
  "damageNumbers",
  "effects",
];

const START_MINUTES = [0, 5, 10, 15, 20] as const;
const STEP_TICKS = [1, 10, 60] as const;
const JUMP_MINUTES = [3, 5, 10, 15, 20] as const;
const SPAWN_COUNTS = [1, 5, 20] as const;
const PICKUPS: readonly RunDevPickup[] = ["medkit", "magnet", "dynamite"];

export function DevSheet(props: { inRun: boolean; onClose(): void }): ReactNode {
  const [tab, setTab] = useState<Tab>("view");
  const settings = useDevMode((state) => state.settings);
  const cheatsMarked = useRun((state) => state.devInfo?.cheats === true);

  return (
    <Modal
      title={t("dev.title")}
      placement="bottom"
      onDismiss={props.onClose}
      footer={
        <Button variant="ghost" block onClick={props.onClose}>
          {t("app.close")}
        </Button>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {(Object.keys(DEV_PRESETS) as DevPresetId[]).map((id) => (
          <Chip key={id} onClick={() => update(() => DEV_PRESETS[id])}>
            {t(`dev.preset.${id}`)}
          </Chip>
        ))}
        {hasCheats(settings) || cheatsMarked ? (
          <Badge tone="warning">{settings.countInRating ? t("dev.cheats.counted") : t("dev.cheats.notCounted")}</Badge>
        ) : null}
      </div>

      <SegmentedControl
        label={t("dev.title")}
        items={TABS.map((id) => ({ id, label: t(`dev.tab.${id}`) }))}
        activeId={tab}
        onSelect={(id) => setTab(id as Tab)}
      />

      <div className="mt-3 grid gap-3">
        {tab === "view" ? <ViewTab settings={settings} /> : null}
        {tab === "time" ? <TimeTab settings={settings} inRun={props.inRun} /> : null}
        {tab === "cheats" ? <CheatsTab settings={settings} /> : null}
        {tab === "world" ? <WorldTab settings={settings} inRun={props.inRun} /> : null}
      </div>
    </Modal>
  );
}

function update(patch: (settings: DevSettings) => DevSettings): void {
  useDevMode.getState().update(patch);
}

function ViewTab(props: { settings: DevSettings }): ReactNode {
  return (
    <ListGroup>
      {VISUAL_KEYS.map((key) => (
        <ListItem
          key={key}
          title={t(`dev.visual.${key}`)}
          toggle={{
            checked: props.settings.visuals[key],
            onChange: () => update((s) => ({ ...s, visuals: { ...s.visuals, [key]: !s.visuals[key] } })),
          }}
        />
      ))}
    </ListGroup>
  );
}

function TimeTab(props: { settings: DevSettings; inRun: boolean }): ReactNode {
  const { settings } = props;
  const paused = useRun((state) => state.phase === "paused");
  return (
    <>
      <Group title={t("dev.time.speed")}>
        <SegmentedControl
          label={t("dev.time.speed")}
          items={TIME_SCALES.map((scale) => ({ id: String(scale), label: `×${scale}` }))}
          activeId={String(settings.timeScale)}
          onSelect={(id) => update((s) => ({ ...s, timeScale: Number(id) }))}
        />
      </Group>
      <ListGroup>
        <ListItem
          title={t("dev.time.spawnPaused")}
          toggle={{ checked: settings.cheats.spawnPaused, onChange: () => toggleCheat("spawnPaused") }}
        />
        <ListItem
          title={t("dev.time.freezeEnemies")}
          hint={t("dev.time.freezeEnemies.hint")}
          toggle={{ checked: settings.cheats.freezeEnemies, onChange: () => toggleCheat("freezeEnemies") }}
        />
      </ListGroup>
      {props.inRun ? (
        <>
          <Group title={t("dev.time.step")} hint={paused ? undefined : t("dev.time.step.hint")}>
            <div className="flex flex-wrap gap-1.5">
              {STEP_TICKS.map((ticks) => (
                <Chip key={ticks} disabled={!paused} onClick={() => command({ kind: "stepTicks", ticks })}>
                  {t(`dev.time.step.${ticks}`)}
                </Chip>
              ))}
            </div>
          </Group>
          <Group title={t("dev.time.jump")} hint={t("dev.time.jump.hint")}>
            <div className="flex flex-wrap gap-1.5">
              {JUMP_MINUTES.map((minute) => (
                <Chip key={minute} onClick={() => command({ kind: "jumpToMinute", minute })}>
                  {t("dev.minute", { minute })}
                </Chip>
              ))}
            </div>
          </Group>
        </>
      ) : null}
    </>
  );
}

function CheatsTab(props: { settings: DevSettings }): ReactNode {
  const { settings } = props;
  return (
    <>
      <ListGroup>
        <ListItem title={t("dev.cheat.godMode")} toggle={{ checked: settings.cheats.godMode, onChange: () => toggleCheat("godMode") }} />
        <ListItem
          title={t("dev.cheat.oneHitKill")}
          toggle={{ checked: settings.cheats.oneHitKill, onChange: () => toggleCheat("oneHitKill") }}
        />
      </ListGroup>
      <Group title={t("dev.cheat.damageMul")}>
        <SegmentedControl
          label={t("dev.cheat.damageMul")}
          items={DAMAGE_MULS.map((value) => ({ id: String(value), label: `×${value}` }))}
          activeId={String(settings.cheats.damageMul)}
          onSelect={(id) => update((s) => ({ ...s, cheats: { ...s.cheats, damageMul: Number(id) } }))}
        />
      </Group>
      <Group title={t("dev.cheat.moveSpeedMul")}>
        <SegmentedControl
          label={t("dev.cheat.moveSpeedMul")}
          items={MOVE_SPEED_MULS.map((value) => ({ id: String(value), label: `×${value}` }))}
          activeId={String(settings.cheats.moveSpeedMul)}
          onSelect={(id) => update((s) => ({ ...s, cheats: { ...s.cheats, moveSpeedMul: Number(id) } }))}
        />
      </Group>
      <ListGroup>
        <ListItem
          title={t("dev.autoPick")}
          hint={t("dev.autoPick.hint")}
          toggle={{
            checked: settings.autoPickUpgrades,
            onChange: () => update((s) => ({ ...s, autoPickUpgrades: !s.autoPickUpgrades })),
          }}
        />
        <ListItem
          title={t("dev.rating")}
          hint={t("dev.rating.hint")}
          toggle={{ checked: settings.countInRating, onChange: () => update((s) => ({ ...s, countInRating: !s.countInRating })) }}
        />
      </ListGroup>
    </>
  );
}

function WorldTab(props: { settings: DevSettings; inRun: boolean }): ReactNode {
  const [weaponId, setWeaponId] = useState(WEAPONS[0]?.id ?? "");
  const [passiveId, setPassiveId] = useState(PASSIVES[0]?.id ?? "");
  const [enemyId, setEnemyId] = useState(ENEMIES[0]?.id ?? "");
  const [count, setCount] = useState<number>(SPAWN_COUNTS[1]);
  const { settings } = props;

  const start = (
    <>
      <Group title={t("dev.start")} hint={props.inRun ? t("dev.start.hintRun") : t("dev.start.hint")}>
        <ListGroup>
          <ListItem
            title={t("dev.start.allWeapons")}
            toggle={{
              checked: settings.start.allWeapons,
              onChange: () => update((s) => ({ ...s, start: { ...s.start, allWeapons: !s.start.allWeapons } })),
            }}
          />
          <ListItem
            title={t("dev.start.allPassives")}
            toggle={{
              checked: settings.start.allPassives,
              onChange: () => update((s) => ({ ...s, start: { ...s.start, allPassives: !s.start.allPassives } })),
            }}
          />
        </ListGroup>
      </Group>
      <Group title={t("dev.start.minute")}>
        <SegmentedControl
          label={t("dev.start.minute")}
          items={START_MINUTES.map((minute) => ({ id: String(minute), label: minute === 0 ? "0" : `${minute}` }))}
          activeId={String(settings.start.minute)}
          onSelect={(id) => update((s) => ({ ...s, start: { ...s.start, minute: Number(id) } }))}
        />
      </Group>
    </>
  );

  if (!props.inRun) return start;

  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" block onClick={() => command({ kind: "levelUp", count: 1 })}>
          {t("dev.world.levelUp")}
        </Button>
        <Button variant="secondary" block onClick={() => command({ kind: "heal" })}>
          {t("dev.world.heal")}
        </Button>
        <Button variant="danger" block onClick={() => command({ kind: "killAll" })}>
          {t("dev.world.killAll")}
        </Button>
        <Button variant="secondary" block onClick={() => command({ kind: "spawnGems", value: 5, count: 20 })}>
          {t("dev.world.gems")}
        </Button>
      </div>

      <Group title={t("dev.world.pickups")}>
        <div className="flex flex-wrap gap-1.5">
          {PICKUPS.map((pickup) => (
            <Chip key={pickup} onClick={() => command({ kind: "spawnPickup", pickup })}>
              {t(`guide.pickup.${pickup}.name`)}
            </Chip>
          ))}
        </div>
      </Group>

      <Group title={t("dev.world.enemy")}>
        <div className="flex flex-wrap gap-1.5">
          {ENEMIES.map((enemy) => (
            <Chip key={enemy.id} active={enemy.id === enemyId} onClick={() => setEnemyId(enemy.id)}>
              {t(`enemy.${enemy.id}.name`)}
            </Chip>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {SPAWN_COUNTS.map((value) => (
            <Chip key={value} active={value === count} onClick={() => setCount(value)}>
              ×{value}
            </Chip>
          ))}
          <Button variant="secondary" onClick={() => command({ kind: "spawnEnemy", id: enemyId, count })}>
            {t("dev.world.spawn")}
          </Button>
        </div>
      </Group>

      <Group title={t("dev.world.weapon")}>
        <ItemPicker
          items={WEAPONS.map((weapon) => ({ id: weapon.id, name: t(weapon.nameKey), levels: weapon.levels.length }))}
          selected={weaponId}
          onSelect={setWeaponId}
          onGive={(level) => command({ kind: "giveWeapon", id: weaponId, level })}
        />
      </Group>

      <Group title={t("dev.world.passive")}>
        <ItemPicker
          items={PASSIVES.map((passive) => ({ id: passive.id, name: t(passive.nameKey), levels: passive.levels.length }))}
          selected={passiveId}
          onSelect={setPassiveId}
          onGive={(level) => command({ kind: "givePassive", id: passiveId, level })}
        />
      </Group>

      {start}
    </>
  );
}

/** Выбор предмета и выдача сразу на первом или на последнем уровне — промежуточные набираются повтором. */
function ItemPicker(props: {
  items: readonly { id: string; name: string; levels: number }[];
  selected: string;
  onSelect(id: string): void;
  onGive(level: number): void;
}): ReactNode {
  const item = props.items.find((entry) => entry.id === props.selected);
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {props.items.map((entry) => (
          <Chip key={entry.id} active={entry.id === props.selected} onClick={() => props.onSelect(entry.id)}>
            {entry.name}
          </Chip>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Button variant="secondary" block onClick={() => props.onGive(1)}>
          {t("dev.world.giveLevel", { level: 1 })}
        </Button>
        <Button variant="secondary" block onClick={() => props.onGive(item?.levels ?? 1)}>
          {t("dev.world.giveMax", { level: item?.levels ?? 1 })}
        </Button>
      </div>
    </>
  );
}

function toggleCheat(key: "godMode" | "oneHitKill" | "freezeEnemies" | "spawnPaused"): void {
  update((s) => ({ ...s, cheats: { ...s.cheats, [key]: !s.cheats[key] } }));
}

function command(value: RunDevCommand): void {
  useRun.getState().devCommand(value);
}

function Group(props: { title: string; hint?: string | undefined; children: ReactNode }): ReactNode {
  return (
    <section>
      <h3 className="mb-1.5 font-display text-xs font-semibold tracking-widest text-text-muted uppercase">{props.title}</h3>
      {props.hint === undefined ? null : <p className="-mt-1 mb-1.5 text-xs text-text-disabled">{props.hint}</p>}
      {props.children}
    </section>
  );
}

function Chip(props: { children: ReactNode; onClick(): void; active?: boolean; disabled?: boolean }): ReactNode {
  return (
    <button
      type="button"
      disabled={props.disabled}
      aria-pressed={props.active}
      onClick={props.onClick}
      className={[
        "min-h-9 rounded-pill px-3 font-display text-sm font-semibold",
        "transition-transform duration-(--duration-fast) ease-base active:scale-[0.97]",
        props.active === true ? "btn-secondary text-text" : "surface-sunken text-text-muted",
        props.disabled === true ? "opacity-40" : "",
      ].join(" ")}
    >
      {props.children}
    </button>
  );
}
