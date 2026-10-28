import { useEffect, type ReactNode } from "react";
import type { RunResult } from "@bh/shared-types";
import { Button } from "../../design-system/components";
import { GemIcon } from "../../design-system/components/CurrencyIcons";
import { t } from "../../i18n";
import "../../i18n/run";
import { gemOffer, useGemContinue, type GemContinueStage, type GemOffer, type GemUnavailableReason } from "../../state/gem-continue";

/**
 * Второй шанс за самоцветы — кнопка с ценой, под ней баланс и нехватка
 * (docs/35-stage4-plan.md Р162, tasks/T-0325). Едет в чанке экрана смерти
 * вместе с `gem-continue.ts`.
 *
 * Не открывается, пока способ жив: даже когда кнопки нет (сервер сказал
 * «недоступно»), компонент остаётся в дереве — размонтирование сбросило бы
 * состояние, и способ спросили бы заново.
 */
export function GemContinue(props: { result: RunResult; locked: boolean; primary: boolean; className?: string }): ReactNode {
  const stage = useGemContinue((state) => state.stage);

  useEffect(() => {
    void useGemContinue.getState().prepare(props.result);
  }, [props.result]);

  // Экран смерти закрыт — ответы по этому забегу больше никому не нужны.
  useEffect(() => () => useGemContinue.getState().reset(), []);

  return (
    <GemContinueView
      stage={stage}
      locked={props.locked}
      primary={props.primary}
      onBuy={() => void useGemContinue.getState().buy()}
      {...(props.className === undefined ? {} : { className: props.className })}
    />
  );
}

/**
 * Само отображение — без сети и стора: его же показывает витрина
 * компонентов. Рендерит одну ячейку сетки блока «Второй шанс».
 *
 * - пока спрашиваем сервер — заглушка той же высоты, без прыжка;
 * - нехватка — выключенная кнопка с подписью, а не скрытая: игрок видит, что
 *   способ есть. В магазин отсюда не ведём: уход закрыл бы забег;
 * - способа нет — кнопки нет, остаётся строка, если игроку есть что сказать.
 *
 * `primary` — главное действие блока (нет ролика): оранжевая заливка;
 * иначе — вторая строка рядом со звёздами.
 */
export function GemContinueView(props: { stage: GemContinueStage; locked: boolean; primary: boolean; onBuy(): void; className?: string }): ReactNode {
  const { stage } = props;
  const variant = props.primary ? "primary" : "secondary";
  const className = props.className ?? "";

  if (stage.kind === "idle" || stage.kind === "loading") {
    return (
      <div className={`grid gap-1 ${className}`}>
        <Button track="continue_gems" block variant={variant} loading={stage.kind === "loading"} disabled ariaLabel={t("run.continue.gems.unknown")}>
          <GemIcon size={18} />
          <span>—</span>
        </Button>
      </div>
    );
  }

  if (stage.kind === "unavailable") {
    const line = unavailableLine(stage.reason);
    return line === null ? null : (
      <p className="order-last col-span-full text-xs text-text-muted" role="status">
        {line}
      </p>
    );
  }

  const { offer } = stage;
  const { affordable, shortfall } = gemOffer(offer);
  const buying = stage.kind === "buying";
  return (
    <div className={`grid gap-1 ${className}`}>
      <Button
        track="continue_gems"
        block
        variant={variant}
        loading={buying}
        disabled={stage.kind !== "ready" || !affordable || props.locked}
        ariaLabel={t("run.continue.gems", { amount: offer.priceGems })}
        onClick={props.onBuy}
      >
        {t("run.continue.gems.action")}
        <GemIcon size={18} />
        <span className="tabular-nums">{offer.priceGems}</span>
      </Button>
      <GemBalance offer={offer} shortfall={shortfall} offline={stage.kind === "ready" && stage.notice === "offline"} />
    </div>
  );
}

/**
 * Баланс и нехватка под кнопкой. На 320 px «У вас N» и «Не хватает M» в одну
 * строку не влезают, поэтому они всегда идут столбцом, а не рядом.
 */
function GemBalance(props: { offer: GemOffer; shortfall: number; offline: boolean }): ReactNode {
  return (
    <div className="grid gap-0.5 text-center text-xs" role="status">
      <span className="text-text-muted tabular-nums">{t("run.continue.gems-balance", { amount: props.offer.balance })}</span>
      {props.shortfall === 0 ? null : <span className="font-semibold text-danger tabular-nums">{t("run.continue.gems-short", { amount: props.shortfall })}</span>}
      {props.offline ? <span className="text-text-muted">{t("run.continue.gems-offline")}</span> : null}
    </div>
  );
}

/** Что сказать, когда способ отпал; остальное — молча: кнопки просто нет. */
function unavailableLine(reason: GemUnavailableReason): string | null {
  if (reason === "insufficient_funds" || reason === "taken") return t(`run.continue.gems-gone.${reason}`);
  return null;
}
