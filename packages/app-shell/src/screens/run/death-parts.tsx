import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Crown, Skull, Sparkles, Trophy, Wrench } from "lucide-react";
import type { RunResult } from "@bh/shared-types";
import { Badge, Button, staggerStyle } from "../../design-system/components";
import { CoinIcon } from "../../design-system/components/CurrencyIcons";
import { formatDuration, formatNumber, hasTranslation, t } from "../../i18n";
import "../../i18n/run";
// Строки награды — в словаре аккаунта: он приезжает с этим чанком, а не с
// первой загрузкой.
import "../../i18n/account";
import { unlockLabel, unlocksGainedBetween } from "../../state/level-unlocks";
import type { RunRewardView } from "../../state/progress";
import { track } from "../../state/shell";
import { ItemIcon } from "../item-icons";
import { bestWeapon, levelBar } from "./death-rules";
import { SecondChance, useSecondChanceStages, visibleWays, type SecondChanceProps } from "./SecondChance";

/**
 * Части экрана смерти (design/screens/death.html): шаг со вторым шансом и
 * шаги итогов. Вынесены из `DeathOverlay.tsx`, чтобы окно собиралось из
 * частей, а не росло одним файлом.
 */

/**
 * Удвоение за рекламу — своим чанком: оно нужно, только когда награда
 * посчитана и в ней есть монеты, а поток рекламы весит больше самой кнопки.
 */
const RunDouble = lazy(async () => ({ default: (await import("./RunDouble")).RunDouble }));

/**
 * Имя врага для игрока. Врагу, которого геймдизайнер добавил без имени в
 * словаре, лучше показать id, чем ключ перевода.
 */
function enemyName(id: string): string {
  const key = `enemy.${id}.name`;
  return hasTranslation(key) ? t(key) : id;
}

/**
 * Шаг 1: второй шанс — главное на экране. Время, кто убил, способы
 * продолжить и тихий отказ. Итогов здесь нет: они предварительные, рекорда и
 * места ещё нет.
 */
export function ChanceStep(props: { result: RunResult; secondChance: SecondChanceProps; onDecline(): void }): ReactNode {
  const { result, secondChance } = props;
  const stages = useSecondChanceStages(secondChance);
  const shown = useRef(false);

  // Шаг показан — один раз: по этому событию считается доля взявших второй
  // шанс. Повторный монтаж в режиме разработки второй раз не пишется.
  useEffect(() => {
    if (shown.current) return;
    shown.current = true;
    const ways = visibleWays(stages);
    track("continue_offered", { ad: ways.ad, stars: ways.stars, vip: ways.vip, elapsedSec: Math.round(result.survivalSec) });
    // Только момент показа: дальше способы меняются сами, и событие не повторяется.
  }, [stages, result.survivalSec]);

  return (
    <div className="grid gap-3">
      <span className="mx-auto inline-flex size-13 items-center justify-center rounded-full bg-danger/15 text-danger ring-1 ring-danger/35">
        <Skull size={26} aria-hidden="true" />
      </span>
      <h2 className="text-center font-display text-[22px] leading-tight text-text">{t("run.death.downed", { time: formatDuration(result.survivalSec) })}</h2>
      {result.deathCause === null ? null : <p className="-mt-1.5 text-center text-[13px] text-text-muted">{t("run.death.cause", { enemy: enemyName(result.deathCause) })}</p>}
      <SecondChance {...secondChance} variant="prominent" />
      <Button variant="secondary" block onClick={props.onDecline}>
        {t("run.death.decline")}
      </Button>
    </div>
  );
}

/**
 * Время — героем: крупно, у рекорда акцентом со свечением; под ним плашки
 * сложности, читов, рекорда и места.
 */
export function ResultsHero(props: { result: RunResult; isNewRecord: boolean; rank?: number | null; cheatsCounted?: boolean }): ReactNode {
  const { result } = props;
  return (
    <div>
      <div className="text-center">
        <div
          className={[
            "font-display text-[46px] leading-none tabular-nums",
            props.isNewRecord ? "text-accent [text-shadow:0_0_24px_color-mix(in_oklab,var(--color-accent)_45%,transparent)]" : "text-text",
          ].join(" ")}
        >
          {formatDuration(result.survivalSec)}
        </div>
        <div className="mt-1 text-xs text-text-muted">{t("run.death.survived")}</div>
      </div>
      {/* Сложность рядом с итогом: рекорд засчитан именно на ней. */}
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        <Badge>{t(`difficulty.${result.difficultyId}.name`)}</Badge>
        {/* Читы — видно сразу: иначе «рекорд» бессмертного забега на скриншоте
            выглядит настоящим. */}
        {result.cheats ? (
          <Badge tone="warning">
            <Wrench size={12} aria-hidden="true" />
            {props.cheatsCounted === true ? t("dev.cheats.counted") : t("dev.cheats.notCounted")}
          </Badge>
        ) : null}
        {props.isNewRecord ? (
          <span className="animate-pop-in" style={staggerStyle(2)}>
            <Badge tone="accent">
              <Crown size={12} aria-hidden="true" />
              {t("run.death.record")}
            </Badge>
          </span>
        ) : null}
        {/* Место приходит с сервера позже итога — плашка появляется, когда
            ответ дошёл, и не задерживает сам экран. */}
        {props.rank === undefined || props.rank === null ? null : (
          <span className="animate-pop-in">
            <Badge tone="info">
              <Trophy size={12} aria-hidden="true" />
              {t("run.death.rank", { rank: props.rank })}
            </Badge>
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Что дал забег. Считает сервер заданием очереди, поэтому сначала «считаем»,
 * потом числа — без перезапуска экрана. Причина отказа видна прямо: игрок,
 * сдавшийся на десятой секунде, должен понять, почему монет нет.
 */
export function RewardCard(props: { reward: RunRewardView; doubleRunId?: string }): ReactNode {
  const { reward } = props;
  // Сколько добавило удвоение за рекламу: строка показывает монеты уже с ним.
  const [bonus, setBonus] = useState(0);
  if (reward.status === "pending") {
    return (
      <div className="surface-sunken rounded-lg p-3">
        <p className="text-xs text-text-muted">{t("run.reward.pending")}</p>
        <LevelBarTrack before={0} after={0.4} pending />
      </div>
    );
  }
  if (reward.status === "none") {
    const key = `run.reward.none.${reward.reason}`;
    return (
      <div className="surface-sunken rounded-lg p-3">
        <p className="text-xs text-text-muted">{hasTranslation(key) ? t(key) : t("run.reward.none.other")}</p>
      </div>
    );
  }
  const bar = levelBar(reward);
  return (
    <div className="surface-sunken animate-rise-in rounded-lg p-3">
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
        <span className="inline-flex items-center gap-1.5 font-display text-xl leading-none tabular-nums text-text" aria-label={t("run.reward.coinsLabel", { amount: reward.coins + bonus })}>
          <CoinIcon size={20} />
          {t("run.reward.coins", { amount: formatNumber(reward.coins + bonus) })}
          {bonus > 0 ? (
            <span className="animate-pop-in">
              <Badge tone="accent">×2</Badge>
            </span>
          ) : null}
        </span>
        <span className="font-display text-sm tabular-nums text-xp">{t("run.reward.xp", { amount: formatNumber(reward.xp) })}</span>
      </div>
      <LevelBarTrack before={bar.before} after={bar.after} />
      <div className="mt-1.5 flex justify-between gap-2 text-[11.5px] text-text-muted">
        <span>{t("run.reward.levelLabel", { level: bar.level })}</span>
        <span>{bar.toNext === null ? t("run.reward.maxLevel") : t("run.reward.toNext", { next: bar.level + 1, xp: formatNumber(bar.toNext) })}</span>
      </div>
      {reward.coinsCapped ? <p className="mt-1.5 text-xs text-text-muted">{t("run.reward.capped")}</p> : null}
      {props.doubleRunId === undefined || reward.coins <= 0 ? null : (
        <Suspense fallback={null}>
          <RunDouble runId={props.doubleRunId} onDoubled={setBonus} />
        </Suspense>
      )}
    </div>
  );
}

/**
 * Полоса уровня: сплошная часть — что было до забега, полупрозрачная — что
 * добавил забег. Анимируется только `transform` (`scaleX`).
 */
function LevelBarTrack(props: { before: number; after: number; pending?: boolean }): ReactNode {
  return (
    <div className="relative mt-2.5 h-1.5 overflow-hidden rounded-sm bg-xp/15" role="presentation">
      <span className={`absolute inset-0 origin-left rounded-sm bg-xp/45 ${props.pending === true ? "animate-pulse" : ""}`} style={{ transform: `scaleX(${props.after})` }} />
      <span className="absolute inset-0 origin-left rounded-sm bg-xp" style={{ transform: `scaleX(${props.before})` }} />
    </div>
  );
}

/** Новый уровень — отдельной плашкой с тем, что открылось (Р42): следующий забег пойдёт уже с этим. */
export function LevelUpCard(props: { levelBefore: number; levelAfter: number }): ReactNode | null {
  if (props.levelAfter <= props.levelBefore) return null;
  const unlocked = unlocksGainedBetween(props.levelBefore, props.levelAfter);
  const firstWeapon = unlocked.find((unlock) => unlock.kind === "weapon");
  return (
    <div className="flex animate-pop-in items-center gap-2.5 rounded-lg border border-xp/45 bg-gradient-to-br from-xp/14 to-surface px-3 py-2.5">
      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-weapon/15 text-weapon">
        {firstWeapon === undefined ? <Sparkles size={18} aria-hidden="true" /> : <ItemIcon kind="weapon" id={firstWeapon.id} size={18} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-display text-[15px] leading-tight text-xp">{t("run.reward.levelUp", { level: props.levelAfter })}</div>
        {unlocked.length === 0 ? null : <div className="mt-0.5 text-[12.5px] text-text">{t("run.reward.unlockedNext", { list: unlocked.map(unlockLabel).join(", ") })}</div>}
      </div>
    </div>
  );
}

/** Три цифры забега: уровень, убито врагов, лучшее оружие. */
export function RunStats(props: { result: RunResult }): ReactNode {
  const { result } = props;
  const best = bestWeapon(result.weapons);
  const cells: { value: ReactNode; label: string }[] = [
    { value: String(result.level), label: t("run.death.runLevel") },
    { value: formatNumber(result.enemiesKilled), label: t("run.death.killed") },
    { value: best === null ? "—" : <span className="text-weapon">{t(`weapon.${best}.name`)}</span>, label: t("run.death.bestWeapon") },
  ];
  return (
    <dl className="grid grid-cols-3 gap-1.5">
      {cells.map((cell) => (
        <div key={cell.label} className="min-w-0 rounded-md border border-border bg-surface px-1.5 py-2 text-center">
          <dd className="truncate font-display text-base leading-tight tabular-nums text-text">{cell.value}</dd>
          <dt className="mt-0.5 text-[11px] text-text-muted">{cell.label}</dt>
        </div>
      ))}
    </dl>
  );
}

/**
 * «Подробнее»: урон по оружиям — главный вход геймдизайнера для баланса
 * (docs/26-stage2-plan.md, WP3) — и кто убил. Раскрытие помнится на устройстве.
 */
export function RunDetails(props: { result: RunResult; open: boolean; diagnostics: boolean; onToggle(open: boolean): void }): ReactNode {
  const { result, open } = props;
  const weapons = [...result.weapons].sort((left, right) => right.damage - left.damage);
  const topDamage = weapons[0]?.damage ?? 0;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => props.onToggle(!open)}
        className="flex h-8 w-full items-center justify-center gap-1.5 text-[12.5px] font-semibold text-text-muted active:text-text"
      >
        {open ? t("run.death.less") : t("run.death.more")}
        {open ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
      </button>
      {open ? (
        <div className="surface-sunken mt-1 grid gap-2 rounded-lg px-3 py-2.5">
          {weapons.length === 0 ? null : (
            <>
              <h3 className="font-display text-xs font-semibold tracking-widest text-text-muted uppercase">{t("run.death.weapons")}</h3>
              <ul className="grid gap-2">
                {weapons.map((weapon, index) => (
                  <li key={weapon.id} className="flex animate-rise-in items-center gap-2 text-sm" style={staggerStyle(index + 1)}>
                    <span className="text-weapon">
                      <ItemIcon kind="weapon" id={weapon.id} size={16} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-text">
                          {t(`weapon.${weapon.id}.name`)}
                          <span className="ml-1 text-text-muted">{weapon.level}</span>
                        </span>
                        <span className="font-display tabular-nums text-text-muted">{formatNumber(weapon.damage)}</span>
                      </span>
                      {/* Доля урона полосой: какое оружие тянуло забег, видно без цифр. */}
                      <span className="surface-sunken mt-1 block h-1 overflow-hidden rounded-pill">
                        <span className="fill-accent block h-full origin-left rounded-pill" style={{ transform: `scaleX(${topDamage > 0 ? weapon.damage / topDamage : 0})` }} />
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {result.deathCause === null ? null : <p className="text-xs text-text-muted">{t("run.death.cause", { enemy: enemyName(result.deathCause) })}</p>}
          {/* seed и runId видны только в режиме диагностики: с ними баг
              воспроизводится, а обычному игроку они ни о чём не говорят. */}
          {props.diagnostics ? <p className="font-mono text-xs break-all text-text-disabled">{t("run.death.diagnostics", { seed: result.seed, runId: result.runId })}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
