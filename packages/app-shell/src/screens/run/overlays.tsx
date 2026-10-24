import { useId, useState, type ReactNode } from "react";
import { ChartColumn, History, Layers, Pause, Sparkles, Star, Wrench } from "lucide-react";
import type { CardTools, UpgradeChange, UpgradeOption } from "@bh/shared-types";
import type { RunSlotState } from "@bh/core-game";
import {
  Badge,
  Button,
  Card,
  CornerRibbon,
  FullscreenButton,
  IconButton,
  Modal,
  RibbonTitle,
  Stat,
} from "../../design-system/components";
import { formatDuration, t } from "../../i18n";
import "../../i18n/run";
import { ItemMedallion, type ItemKind } from "../item-icons";
import { CardToolsBar } from "./CardTools";
import { hintForOffer } from "./evolution-hints";
import { cardTapAction, toolButtons } from "./card-tools-rules";
import { guarded, useTapGuard } from "./overlay-guard";
import { CategoryLabel, ElementLabel, passiveCategoryOf, SlotSummary, weaponElementOf } from "./SlotSummary";
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
          <KeyHint text={t("run.keys.pause")} />
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
  /**
   * Действия с карточками: переброс, пропуск, изгнание. Без поля ряда нет —
   * экран прежний, как у игрока без зарядов.
   */
  tools?: {
    left: CardTools;
    total: CardTools;
    canReroll: boolean;
    onReroll(): void;
    onSkip(): void;
    onBanish(optionId: string): void;
  };
  /** открыть лист «Характеристики» — значком в углу окна, без лишней строки */
  onStats?: () => void;
}

export function LevelUpOverlay(props: LevelUpOverlayProps): ReactNode {
  const ready = useTapGuard();
  const titleId = useId();
  // Режим изгнания привязан к набору карточек: сменились (переброс, изгнание,
  // новый уровень) — он кончился, следующую карточку игрок выбирает заново.
  const offersKey = props.offers.map((offer) => offer.id).join("|");
  const [banish, setBanish] = useState({ key: offersKey, on: false });
  const banishing = banish.on && banish.key === offersKey;
  const tools = props.tools;
  const buttons =
    tools === undefined ? [] : toolButtons({ left: tools.left, total: tools.total, canReroll: tools.canReroll, offers: props.offers });
  const mode = banishing ? "banish" : "choose";
  const tap = (offer: UpgradeOption): void => {
    const action = cardTapAction(mode, offer);
    if (action === "choose") props.onChoose(offer.id);
    else if (action === "banish") tools?.onBanish(offer.id);
  };
  // На узкой панели очередь — «+2» у значка стопки, полностью — для диктора
  // и на широкой панели: строка слотов не должна переноситься (U-13).
  const slotExtras =
    props.queued > 0 ? (
      <Badge tone="accent">
        <Layers size={12} aria-hidden="true" />
        <span className="@sm:hidden" aria-hidden="true">
          +{props.queued}
        </span>
        <span className="sr-only @sm:not-sr-only">{t("run.levelUp.queued", { count: props.queued })}</span>
      </Badge>
    ) : null;

  return (
    <Modal labelledBy={titleId} icon={<Star size={28} fill="currentColor" />} size="l" relic="var(--color-accent)">
      {/* Новый уровень — награда, и окно говорит языком наград v2
          (design/art/direction-v2.md §4.4): реликвия и заголовок на ленте. */}
      <div className="mb-2 flex justify-center short:mb-1">
        <RibbonTitle id={titleId} tone="var(--color-accent)">
          {t("run.levelUp.title", { level: props.level })}
        </RibbonTitle>
      </div>
      {/* «Характеристики» — значком в углу окна: в строке слотов плашка с
          подписью переносила её на вторую строку. Угол не прокручивается
          вместе с карточками. */}
      {props.onStats === undefined ? null : (
        <div className="absolute top-3 right-3 z-10">
          <IconButton label={t("run.stats.open")} onClick={props.onStats}>
            <ChartColumn size={20} className="text-info" />
          </IconButton>
        </div>
      )}
      {/* На невысоком экране подсказка уходит: что выбирать, говорят сами
          карточки, а строка нужна третьей карточке. Основным текстом: верх
          реликвии подсвечен тёплым, и серый на нём падал до 4,47:1. */}
      <p className="-mt-1 mb-2 text-center text-sm text-text short:hidden">{t("run.levelUp.subtitle")}</p>
      <KeyHint text={t("run.keys.choose")} />
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
              onClick={guarded(ready, () => tap(offer))}
            >
              {isNew(offer) ? <CornerRibbon>{t("run.levelUp.new")}</CornerRibbon> : null}
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <ItemMedallion kind={kind} id={offer.refId} />
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
              <EvolutionHint offer={offer} loadout={props.loadout} />
            </Card>
          );
        })}
      </div>
      {tools === undefined ? null : (
        <>
          <CardToolsBar
            buttons={buttons}
            banishing={banishing}
            onReroll={guarded(ready, tools.onReroll)}
            onSkip={guarded(ready, tools.onSkip)}
            onToggleBanish={guarded(ready, () => setBanish({ key: offersKey, on: !banishing }))}
          />
          {/* На невысоком экране подпись уходит: числа на кнопках говорят сами. */}
          {buttons.length === 0 ? null : (
            <p className="mt-2 text-center text-xs text-text-muted short:hidden">{t("run.tools.caption")}</p>
          )}
        </>
      )}
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

/**
 * Рецепт эволюции одной строкой под изменениями (tasks/T-0103): подсказка
 * нужна там, где игрок решает, и только когда есть смысл. Текст, без анимации.
 */
function EvolutionHint(props: { offer: UpgradeOption; loadout: LevelUpOverlayProps["loadout"] }): ReactNode {
  const hint = hintForOffer(props.offer, props.loadout ?? { weapons: [], passives: [] });
  if (hint === null) return null;
  const params = Object.fromEntries(
    Object.entries(hint.params).map(([name, id]) => [name, t(name === "passive" ? `passive.${id}.name` : `weapon.${id}.name`)]),
  );
  return (
    <p className="surface-sunken mt-2 flex items-start gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-text-muted">
      <Sparkles size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
      {t(hint.key, params)}
    </p>
  );
}

function kindOf(offer: UpgradeOption): ItemKind {
  if (offer.kind === "heal") return "heal";
  return offer.kind === "weapon_new" || offer.kind === "weapon_level" || offer.kind === "weapon_evolve" ? "weapon" : "passive";
}

/**
 * Новое это оружие или уровень к уже взятому — игрок должен видеть сразу. У
 * пассивки рядом её категория: слот займёт именно она.
 */
function OfferTag(props: { offer: UpgradeOption }): ReactNode {
  const { offer } = props;
  if (offer.kind === "heal") return null;
  const category = offer.kind === "passive_new" || offer.kind === "passive_level" ? passiveCategoryOf(offer.refId) : null;
  const element = offer.kind === "weapon_new" || offer.kind === "weapon_level" ? weaponElementOf(offer.refId) : null;

  // «Новое» — уголком-лентой карточки, как в окне сундука; здесь — эволюция и уровень.
  const badge =
    offer.kind === "weapon_evolve" ? (
      <Badge tone="accent">
        <Sparkles size={12} aria-hidden="true" />
        {t("run.levelUp.evolve")}
      </Badge>
    ) : isNew(offer) ? null : (
      <Badge tone={offer.kind === "weapon_level" ? "weapon" : "passive"}>
        {t("run.levelUp.upgrade", { level: offer.level })}
      </Badge>
    );

  if (category === null && element === null) return badge;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      {badge}
      {category === null ? null : <CategoryLabel category={category} />}
      {element === null ? null : <ElementLabel element={element} />}
    </span>
  );
}

/**
 * Подсказка клавиш — только там, где есть клавиатура и мышь: на телефоне она
 * была бы шумом.
 */
function KeyHint(props: { text: string }): ReactNode {
  const keyboard = typeof window !== "undefined" && window.matchMedia?.("(hover: hover) and (pointer: fine)").matches === true;
  if (!keyboard) return null;
  return <p className="text-center text-xs text-text-muted">{props.text}</p>;
}
