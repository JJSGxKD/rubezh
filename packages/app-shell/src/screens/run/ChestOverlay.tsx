import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import { Star } from "lucide-react";
import type { ChestReward } from "@bh/shared-types";
import { PASSIVES, WEAPONS } from "@bh/core-game";
import { audio } from "../../audio";
import { Badge, Button, Modal } from "../../design-system/components";
import { t } from "../../i18n";
import "../../i18n/run";
import type { OpenedChest } from "../../state/run";
import { haptic } from "../../state/haptics";
import { ItemTile, type ItemKind } from "../item-icons";
import {
  announceText,
  CHEST_LOOKS,
  CHEST_TIMING,
  chestTier,
  chestTitleKey,
  headlineChange,
  reelStrip,
  revealTimes,
  rewardView,
  sparkVectors,
  type ChestTier,
  type RewardTag,
} from "./chest-rules";
import { guarded, useTapGuard } from "./overlay-guard";
import { formatChange } from "./upgrade-format";

/**
 * Окно сундука (tasks/T-0100, Р102): награды уже выдал движок, окно их
 * показывает. Сцена (design/art/effects.md, «Открытие сундука»): сундук
 * трясётся — крышка слетает со вспышкой, лучами и искрами — награды встают
 * по одной, каждая своим звоном выше прежнего, с выгодой «урон 7 → 9».
 * Ярус сундука виден до первой награды: тоном оковки, числом искр и длиной
 * предвкушения.
 *
 * Выбора нет, поэтому «Забрать» доступно сразу (после защиты от случайного
 * касания): сцена — показ, а не замок. Касание сундука вскрывает его без
 * тряски. Анимируются только `transform` и `opacity`; при «уменьшить
 * движение» сундук открыт сразу и награды стоят на местах.
 */

export interface ChestOverlayProps {
  chest: OpenedChest;
  onTake(): void;
}

/** Отвлекающие плитки ленты — всё оружие и все пассивки контента. */
const REEL_POOL: readonly string[] = [...WEAPONS.map((weapon) => weapon.id), ...PASSIVES.map((passive) => passive.id)];
const WEAPON_IDS: ReadonlySet<string> = new Set(WEAPONS.map((weapon) => weapon.id));

/** Тоны искр по кругу: цвет яруса, монета и светлая искра — добыча, а не пыль. */
const SPARK_TONES = ["var(--chest-tone)", "var(--color-coin)", "var(--color-text)"] as const;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function ChestOverlay(props: ChestOverlayProps): ReactNode {
  const ready = useTapGuard();
  const { chest } = props;
  const titleId = useId();
  const tier = chestTier(chest.size);
  const look = CHEST_LOOKS[tier];
  const [reduced] = useState(prefersReducedMotion);
  const [opened, setOpened] = useState(reduced);
  const times = revealTimes(chest.rewards.length, reduced);

  // Предвкушение: тряска с нарастающим стуком, потом вскрытие само.
  useEffect(() => {
    if (opened) return;
    audio.runEvent("chestRattle");
    const timer = setTimeout(() => setOpened(true), look.shakeMs);
    return () => clearTimeout(timer);
  }, [opened, look.shakeMs]);

  // Вскрытие и звоны наград — по тому же расписанию, что анимация лент.
  useEffect(() => {
    if (!opened) return;
    audio.runEvent("chestOpen");
    haptic("levelUp");
    const timers = times.map((ms, index) =>
      setTimeout(() => {
        audio.chestReveal(index);
        haptic("upgrade");
      }, ms),
    );
    return () => timers.forEach(clearTimeout);
    // Только `opened`: расписание считается от вскрытия один раз, а массив
    // времён новый на каждой отрисовке и перезапускал бы звоны.
  }, [opened]);

  const lastLandMs = times[times.length - 1] ?? 0;

  return (
    <Modal
      labelledBy={titleId}
      hero={
        <ChestScene
          tier={tier}
          opened={opened}
          finaleMs={tier === "grand" ? lastLandMs : null}
          onOpen={() => setOpened(true)}
        />
      }
    >
      {/* Заголовок «бьёт» в миг вскрытия: размер сундука — первое, что игрок узнаёт. */}
      <h2
        id={titleId}
        className={["text-center font-display text-2xl font-bold text-text short:text-xl landscape:text-xl", opened ? "animate-chest-pop" : ""].join(" ")}
      >
        {t(chestTitleKey(chest.size))}
      </h2>
      {/* На невысоком экране подпись уходит: каждая строка на счету. */}
      <p className="mb-2 text-center text-sm text-text-muted short:hidden">{t("run.chest.subtitle", { count: chest.rewards.length })}</p>
      <ul className="mt-2 grid gap-2 short:mt-1 short:gap-1 landscape:grid-cols-2">
        {chest.rewards.map((reward, index) => (
          <RewardRow
            key={`${String(chest.index)}:${String(index)}`}
            index={index}
            reward={reward}
            opened={opened}
            landMs={times[index] ?? 0}
          />
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

/**
 * Сундук над панелью: лучи и сияние за ним, вспышка и искры из-под крышки.
 * У большого сундука, когда встаёт последняя награда, — второй залп искр:
 * добыча закончилась на высокой ноте, а не на тишине.
 */
function ChestScene(props: { tier: ChestTier; opened: boolean; finaleMs: number | null; onOpen(): void }): ReactNode {
  const look = CHEST_LOOKS[props.tier];
  const sparks = sparkVectors(look.sparks);
  const { opened } = props;
  const scene = { "--chest-tone": look.tone, "--chest-shake": `${String(look.shakeMs)}ms` } as CSSProperties;

  return (
    <div className="relative -mb-2 flex h-44 w-full shrink-0 items-end justify-center short:h-32 landscape:mb-0 landscape:h-44 landscape:w-56" style={scene}>
      {/* Лучи: статичный веер, вращается слой целиком — только transform. */}
      <div aria-hidden="true" className="pointer-events-none absolute bottom-6 left-1/2 -ml-56 size-112 -mb-56">
        <div className={["size-full", opened ? "animate-chest-rays-in" : "opacity-0"].join(" ")}>
          <div
            className="size-full animate-chest-rays-spin rounded-full"
            style={{
              backgroundImage: "repeating-conic-gradient(from 0deg, color-mix(in oklab, var(--chest-tone) 38%, transparent) 0deg 7deg, transparent 7deg 22deg)",
              maskImage: "radial-gradient(closest-side, black 18%, transparent 100%)",
            }}
          />
        </div>
      </div>
      {/* Сияние за сундуком: копится в тряске и вспыхивает при вскрытии. */}
      <div
        aria-hidden="true"
        className={[
          "pointer-events-none absolute bottom-2 left-1/2 -ml-24 size-48 rounded-full",
          opened ? "opacity-90" : "animate-fade-in opacity-60",
        ].join(" ")}
        style={{ backgroundImage: "radial-gradient(closest-side, color-mix(in oklab, var(--chest-tone) 55%, transparent), transparent)" }}
      />
      {/* Столб света из-под крышки. */}
      {opened ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-20 left-1/2 -ml-12 h-48 w-24 origin-bottom animate-chest-beam short:bottom-14"
          style={{ backgroundImage: "linear-gradient(to top, color-mix(in oklab, var(--chest-tone) 70%, transparent), transparent)", maskImage: "linear-gradient(to right, transparent, black 30%, black 70%, transparent)" }}
        />
      ) : null}
      <button
        type="button"
        aria-label={t("run.chest.open")}
        disabled={opened}
        onClick={props.onOpen}
        className="relative mb-1 h-32 w-36 disabled:cursor-default short:h-24 short:w-28"
      >
        <span className={["block size-full", opened ? "animate-chest-pop" : "animate-chest-shake"].join(" ")}>
          <ChestArt opened={opened} />
        </span>
        {/* Вспышка — у сундука, а не на весь экран: не слепит в тёмной комнате. */}
        {opened ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-0 left-1/2 -ml-20 size-40 animate-chest-flash rounded-full"
            style={{ backgroundImage: "radial-gradient(closest-side, var(--color-text), color-mix(in oklab, var(--chest-tone) 60%, transparent) 45%, transparent)" }}
          />
        ) : null}
      </button>
      {opened ? <Sparks sparks={sparks} delayMs={0} /> : null}
      {opened && props.finaleMs !== null ? <Sparks sparks={sparks} delayMs={props.finaleMs} /> : null}
    </div>
  );
}

function Sparks(props: { sparks: readonly { x: number; y: number; delayMs: number }[]; delayMs: number }): ReactNode {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute bottom-20 left-1/2 short:bottom-14">
      {props.sparks.map((spark, index) => (
        <span
          key={index}
          className={["absolute animate-chest-spark rounded-sm", index % 3 === 0 ? "-mt-1.5 -ml-1.5 size-3" : "-mt-1 -ml-1 size-2"].join(" ")}
          style={
            {
              "--spark-x": `${String(spark.x)}px`,
              "--spark-y": `${String(spark.y)}px`,
              backgroundColor: SPARK_TONES[index % SPARK_TONES.length],
              animationDelay: `${String(props.delayMs + spark.delayMs)}ms`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

/**
 * Сундук рисуется в оболочке, а не берётся из атласа забега: окно живёт
 * отдельным чанком и не ждёт текстур Phaser. Дерево — общее, оковка и замок
 * — тоном яруса; крышка — отдельной группой, она слетает пружиной.
 */
function ChestArt(props: { opened: boolean }): ReactNode {
  const clip = useId();
  return (
    <svg viewBox="0 0 120 104" className="size-full overflow-visible" aria-hidden="true">
      <ellipse cx="60" cy="97" rx="46" ry="6" fill="var(--color-bg)" opacity="0.6" />
      <rect x="12" y="50" width="96" height="44" rx="4" fill="var(--chest-wood)" />
      <rect x="12" y="84" width="96" height="10" rx="3" fill="var(--chest-wood-lo)" />
      <path d="M12 66 H108 M12 80 H108" stroke="var(--chest-wood-lo)" strokeWidth="2" />
      <rect x="24" y="50" width="9" height="44" fill="var(--chest-tone)" />
      <rect x="87" y="50" width="9" height="44" fill="var(--chest-tone)" />
      {/* Свет изнутри: виден, когда крышка поднялась. */}
      <ellipse cx="60" cy="51" rx="44" ry="5" fill="var(--chest-tone)" opacity={props.opened ? 0.95 : 0} />
      <rect x="50" y="54" width="20" height="22" rx="3" fill="var(--chest-tone)" />
      <circle cx="60" cy="63" r="3" fill="var(--chest-wood-lo)" />
      <rect x="58.8" y="63" width="2.4" height="7" fill="var(--chest-wood-lo)" />
      <g className={props.opened ? "animate-chest-lid" : ""} style={{ transformBox: "fill-box", transformOrigin: "0% 100%" }}>
        <clipPath id={clip}>
          <path d="M12 50 V34 Q12 16 60 16 Q108 16 108 34 V50 Z" />
        </clipPath>
        <path d="M12 50 V34 Q12 16 60 16 Q108 16 108 34 V50 Z" fill="var(--chest-wood-hi)" />
        <g clipPath={`url(#${clip})`}>
          <path d="M12 30 Q60 22 108 30 M12 40 Q60 34 108 40" stroke="var(--chest-wood)" strokeWidth="2" fill="none" />
          <rect x="24" y="14" width="9" height="40" fill="var(--chest-tone)" />
          <rect x="87" y="14" width="9" height="40" fill="var(--chest-tone)" />
        </g>
        <rect x="10" y="46" width="100" height="6" rx="2" fill="var(--chest-tone)" />
      </g>
    </svg>
  );
}

function RewardRow(props: { index: number; reward: ChestReward; opened: boolean; landMs: number }): ReactNode {
  const { index, reward, opened, landMs } = props;
  const view = rewardView(reward);
  const strip = reelStrip(index, reward, REEL_POOL);
  // Число запасной награды «Опыт» — отдельной строкой под названием.
  const xpAmount = reward.kind === "xp" && reward.changes[0] !== undefined ? formatChange(reward.changes[0]).to : null;
  const headline = headlineChange(reward);
  const land = { animationDelay: `${String(landMs)}ms` };
  const after = { animationDelay: `${String(landMs + 120)}ms` };

  return (
    <li className={["surface-sunken relative flex items-center gap-3 overflow-hidden rounded-md px-3 py-1.5 short:py-1", opened ? "animate-chest-land" : ""].join(" ")} style={land}>
      {/* Окно высотой в одну плитку: лента из шести едет вверх и встаёт на награде. */}
      <div className="relative size-12 shrink-0 overflow-hidden rounded-md" aria-hidden="true">
        <div
          className={["flex flex-col motion-reduce:-translate-y-60 motion-reduce:animate-none", opened ? "animate-chest-reel" : ""].join(" ")}
          style={{
            animationDelay: `${String(landMs - CHEST_TIMING.reelMs)}ms`,
            animationDuration: `${String(CHEST_TIMING.reelMs)}ms`,
          }}
        >
          {strip.map((id, position) => (
            <span key={`${String(position)}:${id}`} className="flex size-12 shrink-0 items-center justify-center">
              <ReelTile id={id} />
            </span>
          ))}
        </div>
        {/* До вскрытия плитка закрыта: игрок видит, сколько наград внутри, но не какие. */}
        <span
          className={[
            "absolute inset-0 flex items-center justify-center rounded-md bg-surface-raised font-display text-xl text-text-muted",
            opened ? "animate-chest-cover" : "",
          ].join(" ")}
          style={{ animationDelay: `${String(landMs - CHEST_TIMING.reelMs)}ms` }}
        >
          ?
        </span>
      </div>
      {/* Название, выгода и метка проявляются, когда лента встала. */}
      <div className={["min-w-0 flex-1", opened ? "animate-fade-in motion-reduce:animate-none" : "opacity-0"].join(" ")} style={land}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="min-w-0 font-display text-base font-bold break-words text-text">{t(reward.nameKey)}</span>
          <span className={opened ? "inline-flex animate-pop-in" : "inline-flex opacity-0"} style={after}>
            <RewardTagBadge tag={view.tag} />
          </span>
        </div>
        {xpAmount === null ? null : <div className="font-display text-sm font-semibold text-xp tabular-nums">{xpAmount}</div>}
        {headline === null ? null : <ChangeLine change={headline} />}
      </div>
      {/* Блик по строке в миг, когда награда встала. */}
      {opened ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-1/3 animate-chest-shine"
          style={{ ...land, backgroundImage: "linear-gradient(to right, transparent, color-mix(in oklab, var(--color-text) 22%, transparent), transparent)" }}
        />
      ) : null}
    </li>
  );
}

/** Выгода одной строкой: «урон 7 → 9», новое — просто «урон 6». */
function ChangeLine(props: { change: NonNullable<ReturnType<typeof headlineChange>> }): ReactNode {
  const formatted = formatChange(props.change);
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 text-xs">
      <span className="min-w-0 truncate text-text-muted">{t(props.change.labelKey)}</span>
      <span className="shrink-0 font-display font-semibold whitespace-nowrap tabular-nums">
        {formatted.from === null ? null : (
          <>
            <span className="text-text-muted">{formatted.from}</span>
            <span aria-hidden="true" className="px-1 text-text-disabled">
              →
            </span>
          </>
        )}
        <span className={formatted.better === false ? "text-danger" : "text-success"}>{formatted.to}</span>
      </span>
    </div>
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
