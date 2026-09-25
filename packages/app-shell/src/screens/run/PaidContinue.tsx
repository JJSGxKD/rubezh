import { useEffect, type ReactNode } from "react";
import type { RunResult } from "@bh/shared-types";
import { RotateCw } from "lucide-react";
import { Button } from "../../design-system/components";
import { StarsIcon } from "../../design-system/components/StarsIcon";
import { t } from "../../i18n";
import "../../i18n/run";
import "../../i18n/payments";
import { useContinuePurchase, type ContinueStage } from "../../state/continue-purchase";

/**
 * Покупка второго шанса за звёзды — кнопка с ценой и строка состояния под
 * ней. Едет в чанке экрана смерти (`death-overlay-lazy.tsx`) вместе с
 * `continue-purchase.ts` и своими текстами: в первую загрузку оплата не
 * попадает.
 */
export function PaidContinue(props: { result: RunResult }): ReactNode {
  const stage = useContinuePurchase((state) => state.stage);

  useEffect(() => {
    void useContinuePurchase.getState().prepare(props.result);
  }, [props.result]);

  // Экран смерти закрыт — ожидание подтверждения больше никому не нужно, а не
  // взятое продолжение сервер вернёт сам.
  useEffect(() => () => useContinuePurchase.getState().reset(), []);

  return (
    <PaidContinueView
      stage={stage}
      onBuy={() => void useContinuePurchase.getState().buy()}
      onRetry={() => void useContinuePurchase.getState().retry()}
    />
  );
}

/**
 * Само отображение — без сети и стора: его же показывает витрина компонентов
 * во всех состояниях покупки.
 *
 * Рендерит две ячейки сетки блока «Второй шанс»: кнопку рядом с рекламой и
 * строку состояния на всю ширину под ними.
 */
export function PaidContinueView(props: { stage: ContinueStage; onBuy(): void; onRetry(): void }): ReactNode {
  const { stage } = props;
  const offer = offerOf(stage);
  const busy = stage.kind === "loading" || stage.kind === "buying" || stage.kind === "confirming";
  const line = lineOf(stage);

  return (
    <>
      {/* Не основная: основное действие экрана смерти — «Ещё раз», а на
          оранжевой кнопке фирменная звезда сливалась бы с фоном. Цвет Stars —
          пока покупка идёт или её можно начать; где купить нельзя — обычная
          вторичная, чтобы не звала. */}
      <Button
        block
        variant={busy || stage.kind === "ready" ? "stars" : "secondary"}
        loading={busy}
        disabled={stage.kind !== "ready"}
        ariaLabel={offer === null ? t("run.continue.stars.unknown") : t("run.continue.stars", { amount: offer.priceStars })}
        onClick={props.onBuy}
      >
        <StarsIcon size={18} />
        <span className="tabular-nums">{offer === null ? "—" : offer.priceStars}</span>
      </Button>
      {line === null ? null : (
        <div className="col-span-2 flex items-center justify-between gap-2 text-xs text-text-muted" role="status">
          <span>{line}</span>
          {stage.kind === "retry" ? (
            <Button variant="ghost" onClick={props.onRetry}>
              <RotateCw size={14} aria-hidden="true" />
              {t("run.continue.retry")}
            </Button>
          ) : null}
        </div>
      )}
    </>
  );
}

function lineOf(stage: ContinueStage): string | null {
  switch (stage.kind) {
    case "idle":
    case "loading":
    case "buying":
      return null;
    // Тестовая оплата подписана и здесь, а не только в окне Telegram: через
    // месяц иначе никто не вспомнит, почему продолжение стоило звезду (Р14).
    case "ready":
      return stage.offer.mode === "test" ? t("run.continue.test", { charged: stage.offer.chargedStars }) : null;
    case "confirming":
      return t("run.continue.confirming");
    case "retry":
      return t(`run.continue.retry.${stage.reason}`);
    case "unavailable":
      return t(`run.continue.unavailable.${stage.reason}`);
  }
}

function offerOf(stage: ContinueStage): { priceStars: number } | null {
  if (stage.kind === "ready" || stage.kind === "buying" || stage.kind === "confirming") return stage.offer;
  if (stage.kind === "retry") return stage.offer;
  return null;
}
