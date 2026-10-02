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
  const starsStage = useContinuePurchase((state) => state.stage);
  const liveAdStage = useAdContinue((state) => state.stage);
  const adStage = props.adPreview ?? (props.adFor === undefined ? null : liveAdStage);
  const paidStage = props.paidPreview ?? (props.paidFor === undefined ? null : starsStage);

  // Какие способы есть — до того, как они начнут отпадать: layout-эффект
  // родителя идёт раньше обычных эффектов кнопок, которые спрашивают сервер.
  useLayoutEffect(() => {
    if (!live) return;
    const offers: ContinueOffer[] = [];
    if (props.paidFor !== undefined) offers.push("stars");
    if (props.adFor !== undefined) offers.push("ad");
    expectOffers(offers);
  }, [live, props.paidFor, props.adFor]);

  const vip = adStage !== null && (adStage.kind === "ready" || adStage.kind === "watching") && adStage.pass;
  const showAd = adStage !== null && adStage.kind !== "unavailable";
  const showStars = paidStage !== null && !vip && !(paidStage.kind === "unavailable" && showAd);
  // Звёзды и ролик разом не берутся: пока идёт одно, другое ждёт.
  const starsBusy = paidStage !== null && (paidStage.kind === "buying" || paidStage.kind === "confirming" || (paidStage.kind === "retry" && paidStage.purchaseId !== null));
  const adBusy = adStage?.kind === "watching";
  const placeholder = paidStage === null && adStage === null;
  const wide = !(showAd && showStars) && !placeholder;

  return (
    <section aria-label={t("run.continue.title")} className="surface-sunken rounded-lg p-3">
      <div className="flex items-center gap-3">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-hp/15 text-hp">
          <HeartPulse size={22} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-display text-base font-bold text-text">{t("run.continue.title")}</span>
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
