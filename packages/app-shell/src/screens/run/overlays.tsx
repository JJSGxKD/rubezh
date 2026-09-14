import { useEffect, useState, type ReactNode } from "react";
import { Crown, History, Pause, Skull, Sparkles, Star, Trophy } from "lucide-react";
import type { RunResult, UpgradeChange, UpgradeOption } from "@bh/shared-types";
import type { RunSlotState } from "@bh/core-game";
import {
  Badge,
  Button,
  Card,
  FullscreenButton,
  Modal,
  Stat,
  staggerStyle,
} from "../../design-system/components";
import { formatDuration, formatNumber, hasTranslation, t } from "../../i18n";
import { ItemIcon, ItemTile, type ItemKind } from "../item-icons";
import { SecondChance } from "./SecondChance";
import { CategoryLabel, passiveCategoryOf, SlotSummary } from "./SlotSummary";
import { formatChange } from "./upgrade-format";

/**
 * Оверлеи забега: пауза, выбор улучшения и смерть. Показываются поверх
 * **остановленной** канвы — симуляция в этот момент не делает ни шага, и за
 * главный поток соревноваться не с кем (docs/27-design-system-and-app-shell.md §1.2).
 */

/**
 * Сколько оверлей не принимает нажатия после появления.
 *
 * Палец в этот момент ещё ведёт персонажа: без задержки тап по джойстику
 * выбирает улучшение за игрока и мгновенно закрывает экран смерти
 * (docs/26-stage2-plan.md, WP2). Анимация появления короче задержки — к
 * моменту, когда нажатие разрешено, карточки уже на месте.
 */
const GUARD_MS = 350;

function useTapGuard(): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setReady(true), GUARD_MS);
    return () => clearTimeout(timer);
  }, []);

  return ready;
}

/**
 * Обработчик, который до конца задержки молча ничего не делает. Кнопки при
 * этом не выключаются: иначе на треть секунды они серели бы и гасили ореол
 * ровно во время анимации появления.
 */
function guarded(ready: boolean, action: () => void): () => void {
  return () => {
    if (ready) action();
  };
}

/**
 * Имя врага для игрока. Врагу, которого геймдизайнер добавил без имени в
 * словаре, лучше показать id, чем ключ перевода.
 */
function enemyName(id: string): string {
  const key = `enemy.${id}.name`;
  return hasTranslation(key) ? t(key) : id;
}

export interface PauseOverlayProps {
  elapsedSec: number;
  /** забег только что продолжен из сохранения — экран говорит об этом, а не «пауза» */
  restored?: boolean;
  onResume(): void;
  onSettings(): void;
  onSurrender(): void;
}

export function PauseOverlay(props: PauseOverlayProps): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const ready = useTapGuard();

  if (confirming) {
    return (
      <Modal
        title={t("run.surrender.title")}
        placement="bottom"
        footer={
          <>
            <Button variant="danger" block onClick={guarded(ready, props.onSurrender)}>
              {t("run.surrender.confirm")}
            </Button>
            <Button variant="ghost" block onClick={() => setConfirming(false)}>
              {t("run.surrender.cancel")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-muted">{t("run.surrender.text")}</p>
      </Modal>
    );
  }

  return (
    <Modal
      title={props.restored === true ? t("run.pause.restored") : t("run.pause")}
      icon={props.restored === true ? <History size={26} /> : <Pause size={26} fill="currentColor" />}
      footer={
        <>
          <Button size="l" block glow onClick={guarded(ready, props.onResume)}>
            {t("run.pause.resume")}
          </Button>
          <Button variant="secondary" block onClick={props.onSettings}>
            {t("run.pause.settings")}
          </Button>
          {/* Сдача — с подтверждением: случайный тап не должен обнулять забег. */}
          <Button variant="danger" block onClick={() => setConfirming(true)}>
            {t("run.pause.surrender")}
          </Button>
        </>
      }
    >
      <div className="surface-sunken flex items-center justify-between gap-4 rounded-lg px-4 py-3">
        <Stat label={t("run.death.survived")} value={formatDuration(props.elapsedSec)} large />
        {/* Режим экрана переключается прямо отсюда: забег при этом не
            прерывается (docs/27-design-system-and-app-shell.md §5.2.1). */}
        <FullscreenButton />
      </div>
    </Modal>
  );
}

export interface LevelUpOverlayProps {
  level: number;
  offers: readonly UpgradeOption[];
  queued: number;
  /** текущий набор — показать, сколько слотов каждой категории занято */
  loadout?: { weapons: readonly RunSlotState[]; passives: readonly RunSlotState[] };
  onChoose(optionId: string): void;
}

export function LevelUpOverlay(props: LevelUpOverlayProps): ReactNode {
  const ready = useTapGuard();

  return (
    <Modal
      title={t("run.levelUp.title", { level: props.level })}
      icon={<Star size={28} fill="currentColor" />}
      size="l"
    >
      <p className="-mt-1 mb-2 text-center text-sm text-text-muted">{t("run.levelUp.subtitle")}</p>
      {props.loadout === undefined ? null : (
        <div className="mb-3 landscape:mb-2">
          <SlotSummary weapons={props.loadout.weapons} passives={props.loadout.passives} />
        </div>
      )}
      {/*
        В ландшафте карточки идут в ряд, в портрете — столбцом: высота
        ландшафта на телефоне около 360 px, и три карточки столбцом туда не
        помещаются (docs/27-design-system-and-app-shell.md §5.3). Метка «новое»
        стоит отдельной строкой: рядом с длинным названием она не давала
        колонке сжаться, и модалка уезжала в горизонтальную прокрутку.
      */}
      <div className="grid gap-2 landscape:grid-cols-3">
        {props.offers.map((offer, index) => {
          const kind = kindOf(offer);
          return (
            <Card
              key={offer.id}
              appearIndex={index}
              stripe={kind === "passive" ? "passive" : kind === "weapon" ? "weapon" : "info"}
              onClick={guarded(ready, () => props.onChoose(offer.id))}
            >
              {/* В ландшафте значок и метка в одну строку: колонка узкая, а
                  высота экрана на счету. */}
              <div className="flex items-start gap-3 landscape:flex-col landscape:gap-2">
                <div className="flex items-center gap-2">
                  <ItemTile kind={kind} id={offer.refId} />
                  <span className="hidden landscape:inline">
                    <OfferTag offer={offer} />
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <span className="landscape:hidden">
                    <OfferTag offer={offer} />
                  </span>
                  <span className="mt-1 block font-display text-base font-bold break-words text-text landscape:mt-0">
                    {t(offer.nameKey)}
                  </span>
                  {/* Описание — только у нового: у уровня к взятому предмету
                      важнее, что именно поменяется, а описание игрок уже видел. */}
                  {isNew(offer) || offer.changes.length === 0 ? (
                    <p className="mt-1 text-xs text-text-muted">{t(offer.descriptionKey)}</p>
                  ) : null}
                  <ChangeList changes={offer.changes} />
                </div>
              </div>
            </Card>
          );
        })}
      </div>
      {props.queued > 0 ? (
        <p className="mt-3 text-center text-xs text-text-muted">
          {t("run.levelUp.queued", { count: props.queued })}
        </p>
      ) : null}
    </Modal>
  );
}

function isNew(offer: UpgradeOption): boolean {
  return offer.kind === "weapon_new" || offer.kind === "passive_new";
}

/**
 * Что даёт улучшение: «Урон 6 → 7», «Снаряды 1 → 2». Улучшение подсвечено
 * акцентом и стрелкой — не только цветом (§4.4); у перезарядки лучше, когда
 * число меньше, и цвет это учитывает.
 */
function ChangeList(props: { changes: readonly UpgradeChange[] }): ReactNode {
  if (props.changes.length === 0) return null;

  return (
    <dl className="surface-sunken mt-2 grid gap-1 rounded-md px-2.5 py-2">
      {props.changes.map((change) => {
        const formatted = formatChange(change);
        return (
          <div key={change.labelKey} className="flex items-baseline justify-between gap-2 text-xs">
            <dt className="min-w-0 text-text-muted">{t(change.labelKey)}</dt>
            <dd className="shrink-0 font-display font-semibold tabular-nums whitespace-nowrap">
              {formatted.from === null ? null : (
                <>
                  <span className="text-text-muted">{formatted.from}</span>
                  <span aria-hidden="true" className="px-1 text-text-disabled">
                    →
                  </span>
                </>
              )}
              <span className={formatted.better === false ? "text-warning" : "text-accent"}>
                {formatted.to}
              </span>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function kindOf(offer: UpgradeOption): ItemKind {
  if (offer.kind === "heal") return "heal";
  return offer.kind === "weapon_new" || offer.kind === "weapon_level" ? "weapon" : "passive";
}

/**
 * Новое это оружие или уровень к уже взятому — игрок должен видеть сразу. У
 * пассивки рядом её категория: слот займёт именно она.
 */
function OfferTag(props: { offer: UpgradeOption }): ReactNode {
  const { offer } = props;
  if (offer.kind === "heal") return null;
  const category = offer.kind === "passive_new" || offer.kind === "passive_level" ? passiveCategoryOf(offer.refId) : null;

  const badge =
    offer.kind === "weapon_new" || offer.kind === "passive_new" ? (
      <Badge tone="accent">
        <Sparkles size={12} aria-hidden="true" />
        {t("run.levelUp.new")}
      </Badge>
    ) : (
      <Badge tone={offer.kind === "weapon_level" ? "weapon" : "passive"}>
        {t("run.levelUp.upgrade", { level: offer.level })}
      </Badge>
    );

  if (category === null) return badge;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      {badge}
      <CategoryLabel category={category} />
    </span>
  );
}

export interface DeathOverlayProps {
  result: RunResult;
  isNewRecord: boolean;
  /** место в рейтинге плейтеста; нет — сервер ещё не ответил или его нет */
  rank?: number | null;
  diagnostics: boolean;
  onRestart(): void;
  onMenu(): void;
  onShare(): void;
}

export function DeathOverlay(props: DeathOverlayProps): ReactNode {
  const ready = useTapGuard();
  const { result } = props;
  // Сверху то, что тянуло забег: урон по оружиям — главный вход
  // геймдизайнера для баланса (docs/26-stage2-plan.md, WP3).
  const weapons = [...result.weapons].sort((left, right) => right.damage - left.damage);
  const topDamage = weapons[0]?.damage ?? 0;

  return (
    <Modal
      title={result.outcome === "died" ? t("run.death.title") : t("run.death.abandoned")}
      icon={props.isNewRecord ? <Crown size={28} /> : <Skull size={26} />}
      size="l"
    >
      {/* Сложность рядом с итогом: рекорд засчитан именно на ней. */}
      <div className="-mt-1 mb-3 flex flex-wrap justify-center gap-2">
        <Badge>{t(`difficulty.${result.difficultyId}.name`)}</Badge>
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

      {/* В ландшафте итоги слева, оружие и кнопки справа — «Ещё раз» видна без
          прокрутки (docs/27-design-system-and-app-shell.md §5.3). */}
      <div className="grid gap-4 landscape:grid-cols-2">
        <div>
          <div className="surface-sunken grid grid-cols-2 gap-4 rounded-lg p-4">
            <Stat
              label={t("run.death.survived")}
              value={formatDuration(result.survivalSec)}
              large
              tone={props.isNewRecord ? "accent" : undefined}
            />
            <Stat label={t("run.death.level")} value={String(result.level)} large />
            <Stat label={t("run.death.killed")} value={formatNumber(result.enemiesKilled)} />
            <Stat label={t("run.death.wave")} value={String(result.waveReached)} />
          </div>

          {result.deathCause === null ? null : (
            <p className="mt-3 text-xs text-text-muted">
              {t("run.death.cause", { enemy: enemyName(result.deathCause) })}
            </p>
          )}

          {/* Второй шанс — только после смерти: сданный забег игрок закончил сам. */}
          {result.outcome === "died" ? (
            <div className="mt-3">
              <SecondChance />
            </div>
          ) : null}
        </div>

        <div>
          {weapons.length === 0 ? null : (
            <div>
              <h3 className="mb-2 font-display text-xs font-semibold tracking-widest text-text-muted uppercase">
                {t("run.death.weapons")}
              </h3>
              <ul className="grid gap-2">
                {weapons.map((weapon, index) => (
                  <li
                    key={weapon.id}
                    className="flex animate-rise-in items-center gap-2 text-sm"
                    style={staggerStyle(index + 1)}
                  >
                    <span className="text-weapon">
                      <ItemIcon kind="weapon" id={weapon.id} size={16} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-text">
                          {t(`weapon.${weapon.id}.name`)}
                          <span className="ml-1 text-text-muted">{weapon.level}</span>
                        </span>
                        <span className="font-display tabular-nums text-text-muted">
                          {formatNumber(weapon.damage)}
                        </span>
                      </span>
                      {/* Доля урона полосой: какое оружие тянуло забег, видно без цифр. */}
                      <span className="surface-sunken mt-1 block h-1 overflow-hidden rounded-pill">
                        <span
                          className="fill-accent block h-full origin-left rounded-pill"
                          style={{
                            transform: `scaleX(${topDamage > 0 ? weapon.damage / topDamage : 0})`,
                          }}
                        />
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* seed и runId видны только в режиме диагностики: с ними баг
              воспроизводится, а обычному игроку они ни о чём не говорят. */}
          {props.diagnostics ? (
            <p className="mt-4 font-mono text-xs break-all text-text-disabled">
              {t("run.death.diagnostics", { seed: result.seed, runId: result.runId })}
            </p>
          ) : null}

          <div className="mt-5 grid gap-2">
            <Button size="l" block glow onClick={guarded(ready, props.onRestart)}>
              {t("run.death.again")}
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" block onClick={props.onMenu}>
                {t("run.death.menu")}
              </Button>
              <Button variant="ghost" block onClick={props.onShare}>
                {t("run.death.share")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
