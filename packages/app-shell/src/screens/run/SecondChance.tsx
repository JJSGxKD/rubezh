import type { ReactNode } from "react";
import type { RunResult } from "@bh/shared-types";
import { HeartPulse, Lock, Tv, Wrench } from "lucide-react";
import { Badge, Button } from "../../design-system/components";
import { StarsIcon } from "../../design-system/components/StarsIcon";
import { t } from "../../i18n";
import type { ContinueStage } from "../../state/continue-purchase";
import { PaidContinue, PaidContinueView } from "./PaidContinue";

export interface SecondChanceProps {
  /**
   * Бесплатное продолжение в забеге разработчика — так механика проверяется
   * без денег. Нет — кнопки нет.
   */
  onDevContinue?: () => void;
  /**
   * Забег, чей второй шанс можно купить звёздами. Нет — купить негде: вне
   * Telegram, без входа или забег уже закрыт, и кнопка — только витрина.
   */
  paidFor?: RunResult;
  /** Состояние покупки для витрины компонентов — без сети и без стора. */
  paidPreview?: ContinueStage;
}

/**
 * «Второй шанс» на экране смерти: продолжить забег за звёзды или, позже, за
 * рекламу — все враги вокруг исчезают, здоровье восстанавливается
 * (docs/07-monetization-and-ads.md §8). Реклама — этап 4, её кнопка пока
 * недоступна.
 */
export function SecondChance(props: SecondChanceProps = {}): ReactNode {
  return (
    <section
      aria-label={t("run.continue.title")}
      className="surface-sunken rounded-lg p-3"
    >
      <div className="flex items-center gap-3">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-hp/15 text-hp">
          <HeartPulse size={22} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-display text-base font-bold text-text">
              {t("run.continue.title")}
            </span>
            {/* Купить нельзя — блок честно помечен, а не выглядит сломанным. */}
            {props.paidFor === undefined && props.paidPreview === undefined ? (
              <Badge tone="warning">
                <Lock size={12} aria-hidden="true" />
                {t("app.inDevelopment")}
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-text-muted">{t("run.continue.text")}</p>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {/* Подписи короткие: кнопки делят пополам узкую колонку экрана смерти,
            и «За рекламу» там переносилась на две строки. Полный текст — для
            скринридера. */}
        <Button variant="secondary" block disabled ariaLabel={t("run.continue.ad")}>
          <Tv size={18} aria-hidden="true" />
          {t("run.continue.ad.short")}
        </Button>
        {props.paidFor !== undefined ? (
          <PaidContinue result={props.paidFor} />
        ) : props.paidPreview !== undefined ? (
          <PaidContinueView stage={props.paidPreview} onBuy={() => undefined} onRetry={() => undefined} />
        ) : (
          <StarsPlaceholder />
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

function StarsPlaceholder(): ReactNode {
  return (
    <Button variant="secondary" block disabled ariaLabel={t("run.continue.stars.unknown")}>
      <StarsIcon size={18} />
      <span>—</span>
    </Button>
  );
}
