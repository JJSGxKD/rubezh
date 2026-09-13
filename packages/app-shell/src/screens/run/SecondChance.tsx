import type { ReactNode } from "react";
import { Diamond, HeartPulse, Lock, Tv } from "lucide-react";
import { Badge, Button } from "../../design-system/components";
import { t } from "../../i18n";

/**
 * Цена второго шанса в самоцветах — пример для заглушки, а не прайс: цены
 * появятся вместе с экономикой (docs/07-monetization-and-ads.md §8).
 */
const PREMIUM_PRICE = 10;

/**
 * «Второй шанс» на экране смерти: продолжить забег за рекламу или за
 * самоцветы — все враги вокруг исчезают, здоровье восстанавливается.
 *
 * Пока заглушка: кнопки недоступны и помечены. Живая механика приходит вместе
 * с платежами и рекламой (docs/26-stage2-plan.md §1.2) и требует от движка
 * не закрывать забег сразу после смерти — итог, рекорд и `run_finished`
 * откладываются, пока игрок не откажется от продолжения.
 */
export function SecondChance(): ReactNode {
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
            <Badge tone="warning">
              <Lock size={12} aria-hidden="true" />
              {t("app.inDevelopment")}
            </Badge>
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
        <Button
          variant="secondary"
          block
          disabled
          ariaLabel={t("run.continue.premium", { amount: PREMIUM_PRICE })}
        >
          <Diamond size={18} aria-hidden="true" className="text-passive" />
          <span className="tabular-nums">{PREMIUM_PRICE}</span>
        </Button>
      </div>
    </section>
  );
}
