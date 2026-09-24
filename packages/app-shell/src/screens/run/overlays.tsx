import { useState, type ReactNode } from "react";
import { ChartColumn, History, Layers, Pause, Sparkles, Star, Wrench } from "lucide-react";
import type { UpgradeChange, UpgradeOption } from "@bh/shared-types";
import type { RunSlotState } from "@bh/core-game";
import {
  Badge,
  Button,
  Card,
  FullscreenButton,
  Modal,
  Stat,
} from "../../design-system/components";
import { formatDuration, t } from "../../i18n";
import { ItemTile, type ItemKind } from "../item-icons";
import { guarded, useTapGuard } from "./overlay-guard";
import { CategoryLabel, passiveCategoryOf, SlotSummary } from "./SlotSummary";
import { formatChange } from "./upgrade-format";

/**
 * Оверлеи забега: пауза и выбор улучшения; экран смерти — `DeathOverlay.tsx`,
 * отдельным чанком. Показываются поверх **остановленной** канвы — симуляция в этот момент не делает ни шага, и за
 * главный поток соревноваться не с кем (docs/27-design-system-and-app-shell.md §1.2).
 */

export interface PauseOverlayProps {
  elapsedSec: number;
  /** забег только что продолжен из сохранения — экран говорит об этом, а не «пауза» */
  restored?: boolean;
  onResume(): void;
  onSettings(): void;
  onSurrender(): void;
  onStats(): void;
  /** лист режима разработчика — только у забега разработчика */
  onDev?: () => void;
}

export function PauseOverlay(props: PauseOverlayProps): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const ready = useTapGuard();

  if (confirming) {
    return (
      <Modal
        title={t("run.surrender.title")}
        placement="bottom"
        onDismiss={() => setConfirming(false)}
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
          {/* Характеристики и настройки — в ряд: вторичные действия паузы не
              должны выталкивать «Продолжить» за край в ландшафте. */}
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" block onClick={props.onStats}>
              <ChartColumn size={18} aria-hidden="true" />
              {t("run.stats.open")}
            </Button>
            <Button variant="secondary" block onClick={props.onSettings}>
              {t("run.pause.settings")}
            </Button>
          </div>
          {props.onDev === undefined ? null : (
            <Button variant="secondary" block onClick={props.onDev}>
              <Wrench size={18} aria-hidden="true" />
              {t("dev.title")}
            </Button>
          )}
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
  /** открыть лист «Характеристики» — плашкой в ряду слотов, без лишней строки */
  onStats?: () => void;
}

export function LevelUpOverlay(props: LevelUpOverlayProps): ReactNode {
  const ready = useTapGuard();
  const slotExtras =
    props.queued > 0 || props.onStats !== undefined ? (
      <>
        {props.queued > 0 ? (
          <Badge tone="accent">
            <Layers size={12} aria-hidden="true" />
            {t("run.levelUp.queued", { count: props.queued })}
          </Badge>
        ) : null}
        {props.onStats === undefined ? null : (
          <button
            type="button"
            onClick={props.onStats}
            className="surface-sunken inline-flex items-center gap-1 rounded-pill px-2 py-0.5 font-display text-xs font-semibold text-info"
          >
            <ChartColumn size={12} aria-hidden="true" />
            {t("run.stats.open")}
          </button>
        )}
      </>
    ) : null;

  return (
    <Modal
      title={t("run.levelUp.title", { level: props.level })}
      icon={<Star size={28} fill="currentColor" />}
      size="l"
    >
      {/* На невысоком экране подсказка уходит: что выбирать, говорят сами
          карточки, а строка нужна третьей карточке. */}
      <p className="-mt-1 mb-2 text-center text-sm text-text-muted short:hidden">{t("run.levelUp.subtitle")}</p>
      {/* Сколько выборов ждёт — плашкой в ряду слотов, а не строкой под
          карточками: в ландшафте отдельная строка уводила модалку в прокрутку. */}
      {props.loadout === undefined ? (
        slotExtras === null ? null : <div className="mb-2 flex justify-center">{slotExtras}</div>
      ) : (
        <div className="mb-3 short:mb-2">
          <SlotSummary
            weapons={props.loadout.weapons}
            passives={props.loadout.passives}
            {...(slotExtras === null ? {} : { extra: slotExtras })}
          />
        </div>
      )}
      {/*
        В ландшафте карточки идут в ряд, в портрете — столбцом: высота
        ландшафта на телефоне около 360 px, и три карточки столбцом туда не
        помещаются (docs/27-design-system-and-app-shell.md §5.3).

        Значок, название и метка — одной строкой с переносом, а не столбцом
        под значком: столбец съедал ширину у описания и строку у высоты, и на
        экране 360×640 третья карточка уходила под прокрутку. Метка переносится
        сама, когда рядом с длинным названием ей не хватает места, — колонка
        при этом сжимается, а не уезжает в горизонтальную прокрутку.
      */}
      <div className="grid gap-2 landscape:grid-cols-3">
        {props.offers.map((offer, index) => {
          const kind = kindOf(offer);
          return (
            <Card
              key={offer.id}
              appearIndex={index}
              compact
              stripe={kind === "passive" ? "passive" : kind === "weapon" ? "weapon" : "info"}
              onClick={guarded(ready, () => props.onChoose(offer.id))}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <ItemTile kind={kind} id={offer.refId} size="s" />
                <span className="min-w-0 font-display text-base font-bold break-words text-text">
                  {t(offer.nameKey)}
                </span>
                <OfferTag offer={offer} />
              </div>
              {/* Описание — только у нового: у уровня к взятому предмету
                  важнее, что именно поменяется, а описание игрок уже видел. */}
              {/* В ландшафте колонка узкая и описание расползается на три-четыре
                  строки — там оно обрезается до двух: числа ниже важнее. */}
              {isNew(offer) || offer.changes.length === 0 ? (
                <p className="mt-1.5 text-xs text-text-muted landscape:line-clamp-2">{t(offer.descriptionKey)}</p>
              ) : null}
              <ChangeList changes={offer.changes} />
            </Card>
          );
        })}
      </div>
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
    <dl className="surface-sunken mt-2 grid gap-0.5 rounded-md px-2.5 py-1.5">
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
