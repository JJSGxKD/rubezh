import { useLayoutEffect, type ReactNode } from "react";
import type { RunResult } from "@bh/shared-types";
import { HeartPulse, Lock, Tv, Wrench } from "lucide-react";
import { Badge, Button } from "../../design-system/components";
import { StarsIcon } from "../../design-system/components/StarsIcon";
import { t } from "../../i18n";
import "../../i18n/run";
import { useAdContinue, type AdContinueStage } from "../../state/ad-continue";
import { useContinuePurchase, type ContinueStage } from "../../state/continue-purchase";
import { expectOffers, type ContinueOffer } from "../../state/second-chance-offers";
import { AdContinue, AdContinueView } from "./AdContinue";
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
  /**
   * `inline` — блок среди прочего (витрина, прежние места); `prominent` —
   * главное на экране шага второго шанса: подложка в тоне здоровья.
   */
  variant?: "inline" | "prominent";
}

/**
 * Какие способы продолжить видны. Отпал способ — его кнопка уходит; у VIP —
 * одна кнопка, а звёзды и ролик не предлагаются: платить за то, что даётся
 * бесплатно, незачем. Звёзды, когда купить нельзя, а ролик есть, тоже уходят.
 */
export function visibleWays(input: { adStage: AdContinueStage | null; paidStage: ContinueStage | null }): { ad: boolean; stars: boolean; vip: boolean } {
  const { adStage, paidStage } = input;
  const vip = adStage !== null && (adStage.kind === "ready" || adStage.kind === "watching") && adStage.pass;
  const showAd = adStage !== null && adStage.kind !== "unavailable";
  const stars = paidStage !== null && !vip && !(paidStage.kind === "unavailable" && showAd);
  return { ad: showAd && !vip, stars, vip };
}

/**
 * Состояния способов продолжить: живые из сторов, у витрины — заданные
 * образцы. Нет способа — `null`.
 */
export function useSecondChanceStages(props: SecondChanceProps): { adStage: AdContinueStage | null; paidStage: ContinueStage | null } {
  const starsStage = useContinuePurchase((state) => state.stage);
  const liveAdStage = useAdContinue((state) => state.stage);
  return {
    adStage: props.adPreview ?? (props.adFor === undefined ? null : liveAdStage),
    paidStage: props.paidPreview ?? (props.paidFor === undefined ? null : starsStage),
  };
}

/**
 * «Второй шанс» на экране смерти: продолжить забег за рекламу или звёзды —
 * все враги вокруг исчезают, здоровье восстанавливается
 * (docs/07-monetization-and-ads.md §8, docs/35-stage4-plan.md WP11).
 *
 * Видны только те способы, которыми продолжить можно: отпал способ — его
 * кнопка уходит, а вторая занимает всю ширину. У VIP — одна кнопка
 * «Продолжить с VIP»: платить звёздами за то, что даётся бесплатно, незачем.
 * Отпали оба — забег закрывается смертью (`second-chance-offers.ts`).
 */
export function SecondChance(props: SecondChanceProps = {}): ReactNode {
  const live = props.paidFor !== undefined || props.adFor !== undefined;
  const { adStage, paidStage } = useSecondChanceStages(props);

  // Какие способы есть — до того, как они начнут отпадать: layout-эффект
  // родителя идёт раньше обычных эффектов кнопок, которые спрашивают сервер.
  useLayoutEffect(() => {
    if (!live) return;
    const offers: ContinueOffer[] = [];
    if (props.paidFor !== undefined) offers.push("stars");
    if (props.adFor !== undefined) offers.push("ad");
    expectOffers(offers);
  }, [live, props.paidFor, props.adFor]);

  const { ad: showAd, stars: showStars } = visibleWays({ adStage, paidStage });
  // Звёзды и ролик разом не берутся: пока идёт одно, другое ждёт.
  const starsBusy = paidStage !== null && (paidStage.kind === "buying" || paidStage.kind === "confirming" || (paidStage.kind === "retry" && paidStage.purchaseId !== null));
  const adBusy = adStage?.kind === "watching";
  const placeholder = paidStage === null && adStage === null;
  const wide = !(showAd && showStars) && !placeholder;
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
      <div className={`mt-3 grid gap-2 ${wide ? "grid-cols-1" : "grid-cols-2"}`}>
        {placeholder ? (
          <>
            <Button variant="secondary" block disabled ariaLabel={t("run.continue.ad")}>
              <Tv size={18} aria-hidden="true" />
              {t("run.continue.ad.short")}
            </Button>
            <Button variant="secondary" block disabled ariaLabel={t("run.continue.stars.unknown")}>
              <StarsIcon size={18} />
              <span>—</span>
            </Button>
          </>
        ) : null}
        {adStage === null ? null : props.adFor !== undefined ? (
          <AdContinue result={props.adFor} locked={starsBusy} wide={wide} />
        ) : (
          <AdContinueView stage={adStage} locked={starsBusy} wide={wide} onWatch={() => undefined} />
        )}
        {!showStars ? null : props.paidFor !== undefined ? (
          <PaidContinue result={props.paidFor} locked={adBusy} />
        ) : paidStage === null ? null : (
          <PaidContinueView stage={paidStage} locked={adBusy} onBuy={() => undefined} onRetry={() => undefined} />
        )}
      </div>
      {props.onDevContinue === undefined ? null : (
        <div className="mt-2">
          <Button block onClick={props.onDevContinue}>
            <Wrench size={18} aria-hidden="true" />
            {t("run.continue.dev")}
          </Button>
        </div>
      )}
    </section>
  );
}
