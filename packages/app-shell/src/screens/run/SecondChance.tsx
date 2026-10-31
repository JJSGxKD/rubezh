import { useLayoutEffect, type ReactNode } from "react";
import type { RunResult } from "@bh/shared-types";
import { HeartPulse, Lock, Tv, Wrench } from "lucide-react";
import { Badge, Button } from "../../design-system/components";
import { StarsIcon } from "../../design-system/components/StarsIcon";
import { t } from "../../i18n";
import "../../i18n/run";
import { useAdContinue, type AdContinueStage } from "../../state/ad-continue";
import { useContinuePurchase, type ContinueStage } from "../../state/continue-purchase";
import { useGemContinue, type GemContinueStage } from "../../state/gem-continue";
import { expectOffers, type ContinueOffer } from "../../state/second-chance-offers";
import { AdContinue, AdContinueView } from "./AdContinue";
import { GemContinue, GemContinueView } from "./GemContinue";
import { PaidContinue, PaidContinueView } from "./PaidContinue";

export interface SecondChanceProps {
  /**
   * Бесплатное продолжение в забеге разработчика — так механика проверяется
   * без денег. Нет — кнопки нет.
   */
  onDevContinue?: () => void;
  /** Забег, чей второй шанс можно купить звёздами. Нет — купить негде: вне Telegram или без входа. */
  paidFor?: RunResult;
  /** Состояние покупки для витрины компонентов — без сети и без стора. */
  paidPreview?: ContinueStage;
  /** Забег, чей второй шанс можно взять за рекламу или с VIP. Нет — площадка рекламу не показывает или нет входа. */
  adFor?: RunResult;
  /** Состояние рекламы для витрины компонентов. */
  adPreview?: AdContinueStage;
  /** Забег, чей второй шанс можно взять за самоцветы. Нет — нет входа в аккаунт. */
  gemsFor?: RunResult;
  /** Состояние самоцветов для витрины компонентов. */
  gemsPreview?: GemContinueStage;
  /**
   * `inline` — блок среди прочего (витрина, прежние места); `prominent` —
   * главное на экране шага второго шанса: подложка в тоне здоровья.
   */
  variant?: "inline" | "prominent";
}

/** Состояния проверок способов второго шанса; `null` — способа на экране нет. */
export interface WayStages {
  adStage: AdContinueStage | null;
  paidStage: ContinueStage | null;
  /** не задан — самоцветов нет, как в сборках до Р162 */
  gemStage?: GemContinueStage | null;
}

export interface VisibleWays {
  ad: boolean;
  gems: boolean;
  stars: boolean;
  vip: boolean;
}

/**
 * Какие способы продолжить видны. Отпал способ — его кнопка уходит; у VIP —
 * одна кнопка, а звёзды, самоцветы и ролик не предлагаются: платить за то, что
 * даётся бесплатно, незачем. Звёзды, когда купить нельзя, а есть ролик или
 * самоцветы, тоже уходят.
 */
export function visibleWays(input: WayStages): VisibleWays {
  const { adStage, paidStage } = input;
  const gemStage = input.gemStage ?? null;
  const vip = adStage !== null && (adStage.kind === "ready" || adStage.kind === "watching") && adStage.pass;
  const showAd = adStage !== null && adStage.kind !== "unavailable";
  const showGems = gemStage !== null && !vip && gemStage.kind !== "unavailable";
  const stars = paidStage !== null && !vip && !(paidStage.kind === "unavailable" && (showAd || showGems));
  return { ad: showAd && !vip, gems: showGems, stars, vip };
}

/**
 * Порядок кнопок на экране: ролик, если он есть, — главная; нет ролика —
 * главные самоцветы; звёзды — всегда последними. У VIP одна кнопка.
 */
export function wayOrder(ways: VisibleWays): ("ad" | "gems" | "stars" | "vip")[] {
  if (ways.vip) return ["vip"];
  const order: ("ad" | "gems" | "stars")[] = [];
  if (ways.ad) order.push("ad");
  if (ways.gems) order.push("gems");
  if (ways.stars) order.push("stars");
  return order;
}

/**
 * Ответили ли проверки способов. Пока ролик (`idle`, `checking`), звёзды или
 * самоцветы (`idle`, `loading`) спрашивают сервер, флаги `visibleWays` —
 * догадка: ролик «есть», VIP «нет». Способа нет вовсе (`null`) — спрашивать
 * нечего, это тоже ответ.
 */
export function waysAnswered(input: WayStages): boolean {
  const { adStage, paidStage } = input;
  const gemStage = input.gemStage ?? null;
  const adAsking = adStage !== null && (adStage.kind === "idle" || adStage.kind === "checking");
  const paidAsking = paidStage !== null && (paidStage.kind === "idle" || paidStage.kind === "loading");
  const gemAsking = gemStage !== null && (gemStage.kind === "idle" || gemStage.kind === "loading");
  return !adAsking && !paidAsking && !gemAsking;
}

/** Тело события `continue_offered`. `null` — слать нечего: ответов ещё нет или предложить нечего. */
export function continueOfferedPayload(
  input: WayStages,
  survivalSec: number,
): { ad: boolean; gems: boolean; stars: boolean; vip: boolean; elapsedSec: number } | null {
  if (!waysAnswered(input)) return null;
  // Все существующие способы отпали (или их нет): шага у игрока нет, предлагать было нечего.
  const adGone = input.adStage === null || input.adStage.kind === "unavailable";
  const paidGone = input.paidStage === null || input.paidStage.kind === "unavailable";
  const gemGone = input.gemStage == null || input.gemStage.kind === "unavailable";
  if (adGone && paidGone && gemGone) return null;
  return { ...visibleWays(input), elapsedSec: Math.round(survivalSec) };
}

/**
 * Состояния способов продолжить: живые из сторов, у витрины — заданные
 * образцы. Нет способа — `null`.
 */
export function useSecondChanceStages(props: SecondChanceProps): { adStage: AdContinueStage | null; paidStage: ContinueStage | null; gemStage: GemContinueStage | null } {
  const starsStage = useContinuePurchase((state) => state.stage);
  const liveAdStage = useAdContinue((state) => state.stage);
  const liveGemStage = useGemContinue((state) => state.stage);
  return {
    adStage: props.adPreview ?? (props.adFor === undefined ? null : liveAdStage),
    paidStage: props.paidPreview ?? (props.paidFor === undefined ? null : starsStage),
    gemStage: props.gemsPreview ?? (props.gemsFor === undefined ? null : liveGemStage),
  };
}

/**
 * «Второй шанс» на экране смерти: продолжить забег за рекламу, самоцветы или
 * звёзды — все враги вокруг исчезают, здоровье восстанавливается
 * (docs/07-monetization-and-ads.md §8, docs/35-stage4-plan.md WP11, Р162).
 *
 * Видны только те способы, которыми продолжить можно: отпал способ — его
 * кнопка уходит, а соседняя занимает всю ширину. Есть ролик — он главный,
 * самоцветы и звёзды вторым рядом; ролика нет — главные самоцветы. У VIP —
 * одна кнопка «Продолжить с VIP»: платить за то, что даётся бесплатно, незачем.
 * Отпали все — забег закрывается смертью (`second-chance-offers.ts`).
 */
export function SecondChance(props: SecondChanceProps = {}): ReactNode {
  const live = props.paidFor !== undefined || props.adFor !== undefined || props.gemsFor !== undefined;
  const { adStage, paidStage, gemStage } = useSecondChanceStages(props);

  // Какие способы есть — до того, как они начнут отпадать: layout-эффект
  // родителя идёт раньше обычных эффектов кнопок, которые спрашивают сервер.
  useLayoutEffect(() => {
    if (!live) return;
    const offers: ContinueOffer[] = [];
    if (props.paidFor !== undefined) offers.push("stars");
    if (props.adFor !== undefined) offers.push("ad");
    if (props.gemsFor !== undefined) offers.push("gems");
    expectOffers(offers);
  }, [live, props.paidFor, props.adFor, props.gemsFor]);

  const { ad: showAd, gems: showGems, stars: showStars } = visibleWays({ adStage, paidStage, gemStage });
  // Способы разом не берутся: пока идёт один, остальные ждут.
  const starsBusy = paidStage !== null && (paidStage.kind === "buying" || paidStage.kind === "confirming" || (paidStage.kind === "retry" && paidStage.purchaseId !== null));
  const adBusy = adStage?.kind === "watching";
  const gemsBusy = gemStage?.kind === "buying";
  const placeholder = paidStage === null && adStage === null && gemStage === null;
  // Без самоцветов ролик и звёзды делят ряд пополам, пока есть оба. С самоцветами
  // ролик — отдельным рядом, самоцветы со звёздами — вторым.
  const wide = !(showAd && showStars) && !placeholder;
  const adRow = showGems && showAd;
  const gemsAlone = !(showAd && showStars);
  const starsAlone = !showAd;
  const prominent = props.variant === "prominent";

  return (
    <section
      aria-label={t("run.continue.title")}
      className={
        prominent
          ? "rounded-lg border border-hp/45 bg-gradient-to-br from-hp/12 to-surface p-3.5 shadow-[0_0_28px_-10px_var(--color-hp)]"
          : "surface-sunken rounded-lg p-3"
      }
    >
      <div className="flex items-center gap-3">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-hp/15 text-hp">
          <HeartPulse size={22} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={`font-display font-bold text-text ${prominent ? "text-[17px]" : "text-base"}`}>{t("run.continue.title")}</span>
            {/* Продолжить нечем — блок честно помечен, а не выглядит сломанным. */}
            {placeholder ? (
              <Badge tone="warning">
                <Lock size={12} aria-hidden="true" />
                {t("app.inDevelopment")}
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-text-muted">{t("run.continue.text")}</p>
        </div>
      </div>
      <div className={`mt-3 grid gap-2 ${showGems ? "grid-cols-2" : wide ? "grid-cols-1" : "grid-cols-2"}`}>
        {placeholder ? (
          <>
            <Button track="continue_ad" variant="secondary" block disabled ariaLabel={t("run.continue.ad")}>
              <Tv size={18} aria-hidden="true" />
              {t("run.continue.ad.short")}
            </Button>
            <Button track="continue_stars" variant="secondary" block disabled ariaLabel={t("run.continue.stars.unknown")}>
              <StarsIcon size={18} />
              <span>—</span>
            </Button>
          </>
        ) : null}
        {/* Обёртки без собственной вёрстки (`contents`): кнопки остаются ячейками
            общей сетки, а дерево не меняется, когда способы отпадают, — иначе
            компонент размонтировался бы и сбросил свою проверку. */}
        {adStage === null ? null : (
          <div className={`contents ${adRow ? "[&>button]:col-span-full" : ""}`}>
            {props.adFor !== undefined ? (
              <AdContinue result={props.adFor} locked={starsBusy || gemsBusy} wide={wide || adRow} />
            ) : (
              <AdContinueView stage={adStage} locked={starsBusy || gemsBusy} wide={wide || adRow} onWatch={() => undefined} />
            )}
          </div>
        )}
        {gemStage === null ? null : props.gemsFor !== undefined ? (
          <GemContinue result={props.gemsFor} locked={adBusy || starsBusy} primary={!showAd} className={gemsAlone ? "col-span-full" : ""} />
        ) : (
          <GemContinueView stage={gemStage} locked={adBusy || starsBusy} primary={!showAd} onBuy={() => undefined} className={gemsAlone ? "col-span-full" : ""} />
        )}
        {!showStars ? null : (
          <div className={`contents ${showGems && starsAlone ? "[&>button]:col-span-full" : ""}`}>
            {props.paidFor !== undefined ? (
              <PaidContinue result={props.paidFor} locked={adBusy || gemsBusy} />
            ) : paidStage === null ? null : (
              <PaidContinueView stage={paidStage} locked={adBusy || gemsBusy} onBuy={() => undefined} onRetry={() => undefined} />
            )}
          </div>
        )}
      </div>
      {props.onDevContinue === undefined ? null : (
        <div className="mt-2">
          <Button track="continue_dev" block onClick={props.onDevContinue}>
            <Wrench size={18} aria-hidden="true" />
            {t("run.continue.dev")}
          </Button>
        </div>
      )}
    </section>
  );
}
