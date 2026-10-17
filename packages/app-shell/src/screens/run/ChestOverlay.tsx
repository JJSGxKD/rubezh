import type { CSSProperties, ReactNode } from "react";
import { Gift, Star } from "lucide-react";
import type { ChestReward } from "@bh/shared-types";
import { PASSIVES, WEAPONS } from "@bh/core-game";
import { Badge, Button, Modal } from "../../design-system/components";
import { t } from "../../i18n";
import "../../i18n/run";
import type { OpenedChest } from "../../state/run";
import { ItemTile, type ItemKind } from "../item-icons";
import { announceText, chestTitleKey, reelStrip, rewardView, type RewardTag } from "./chest-rules";
import { guarded, useTapGuard } from "./overlay-guard";
import { formatChange } from "./upgrade-format";

/**
 * Окно сундука (tasks/T-0100, Р102): награды уже выдал движок, окно только
 * показывает «барабан» по каждой и закрывается. Выбора здесь нет, поэтому
 * «Забрать» доступно сразу (после защиты от случайного касания): анимация —
 * показ, а не замок.
 *
 * Ориентир по виду — `LevelUpOverlay`. Анимируются только `transform` и
 * `opacity`, длительности — токены. Быстрое движение системы убирает ленту:
 * награды появляются сразу.
 */

export interface ChestOverlayProps {
  chest: OpenedChest;
  onTake(): void;
}

/** Отвлекающие плитки ленты — всё оружие и все пассивки контента. */
const REEL_POOL: readonly string[] = [...WEAPONS.map((weapon) => weapon.id), ...PASSIVES.map((passive) => passive.id)];
const WEAPON_IDS: ReadonlySet<string> = new Set(WEAPONS.map((weapon) => weapon.id));

export function ChestOverlay(props: ChestOverlayProps): ReactNode {
  const ready = useTapGuard();
  const { chest } = props;

  return (
    <Modal title={t(chestTitleKey(chest.size))} icon={<Gift size={28} />}>
      {/* На невысоком экране подпись уходит: каждая строка на счету. */}
      <p className="-mt-1 mb-2 text-center text-sm text-text-muted short:hidden">
        {t("run.chest.subtitle", { count: chest.rewards.length })}
      </p>
      <ul className="grid gap-2 short:gap-1.5 landscape:grid-cols-2">
        {chest.rewards.map((reward, index) => (
          <RewardRow key={`${String(chest.index)}:${String(index)}`} index={index} reward={reward} />
        ))}
      </ul>
      {/* Скринридеру лента не нужна — он слышит итог одной строкой. */}
      <p className="sr-only" aria-live="polite">
        {announceText(
          chest.rewards.map((reward) => t(reward.nameKey)),
          t,
        )}
      </p>
      <div className="mt-4 grid gap-2 short:mt-2">
        <Button size="l" block glow onClick={guarded(ready, props.onTake)}>
          {t("run.chest.take")}
        </Button>
      </div>
    </Modal>
  );
}

function RewardRow(props: { index: number; reward: ChestReward }): ReactNode {
  const { index, reward } = props;
  const view = rewardView(reward);
  const strip = reelStrip(index, reward, REEL_POOL);
  // Число запасной награды «Опыт» — отдельной строкой под названием.
  const xpAmount = reward.kind === "xp" && reward.changes[0] !== undefined ? formatChange(reward.changes[0]).to : null;
  const row = { "--row": index } as CSSProperties;

  return (
    <li className="surface-sunken flex items-center gap-3 rounded-md px-3 py-1.5" style={row}>
      {/* Окно высотой в одну плитку: лента из шести едет вверх и встаёт на награде. */}
      <div className="size-12 shrink-0 overflow-hidden rounded-md" aria-hidden="true">
        <div
          className="flex animate-chest-reel flex-col motion-reduce:-translate-y-60 motion-reduce:animate-none"
          style={{ animationDelay: "calc(var(--row) * var(--duration-base))" }}
        >
          {strip.map((id, position) => (
            <span key={`${String(position)}:${id}`} className="flex size-12 shrink-0 items-center justify-center">
              <ReelTile id={id} />
            </span>
          ))}
        </div>
      </div>
      {/* Название и метка проявляются, когда лента встала: строка + длительность ленты. */}
      <div
        className="min-w-0 flex-1 animate-fade-in motion-reduce:animate-none"
        style={{ animationDelay: "calc(var(--row) * var(--duration-base) + var(--duration-slow))" }}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="min-w-0 font-display text-base font-bold break-words text-text">{t(reward.nameKey)}</span>
          <RewardTagBadge tag={view.tag} />
        </div>
        {xpAmount === null ? null : <div className="font-display text-sm font-semibold text-xp tabular-nums">{xpAmount}</div>}
      </div>
    </li>
  );
}

function RewardTagBadge(props: { tag: RewardTag }): ReactNode {
  const { tag } = props;
  if (tag === null) return null;
  return tag.kind === "new" ? (
    <Badge tone="accent">{t("run.levelUp.new")}</Badge>
  ) : (
    <Badge tone="accent">{t("run.levelUp.upgrade", { level: tag.level })}</Badge>
  );
}

/**
 * Плитка ленты по id: оружие или пассивка контента, лечение или опыт. Опыт
 * рисуется своей плиткой той же формы — вид предмета (`ItemKind`) ради него
 * не расширяется.
 */
function ReelTile(props: { id: string }): ReactNode {
  if (props.id === "xp") {
    return (
      <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-md bg-xp/15 text-xp">
        <Star size={22} fill="currentColor" aria-hidden="true" />
      </span>
    );
  }
  const kind: ItemKind = props.id === "heal" ? "heal" : WEAPON_IDS.has(props.id) ? "weapon" : "passive";
  return <ItemTile kind={kind} id={props.id === "heal" ? "" : props.id} />;
}
