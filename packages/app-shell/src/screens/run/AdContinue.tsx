import { useEffect, type ReactNode } from "react";
import type { RunResult } from "@bh/shared-types";
import { Crown, Tv } from "lucide-react";
import { Button } from "../../design-system/components";
import { t } from "../../i18n";
import "../../i18n/run";
import "../../i18n/payments";
import { useAdContinue, type AdContinueStage } from "../../state/ad-continue";

/**
 * Второй шанс за рекламу — кнопка и строка состояния под ней
 * (docs/35-stage4-plan.md WP11). У VIP — «Продолжить с VIP» без ролика.
 * Едет в чанке экрана смерти вместе с потоком рекламы.
 */
export function AdContinue(props: { result: RunResult; locked: boolean; wide: boolean }): ReactNode {
  const stage = useAdContinue((state) => state.stage);

  useEffect(() => {
    void useAdContinue.getState().prepare(props.result);
  }, [props.result]);

  // Экран смерти закрыт — ответы по этому забегу больше никому не нужны.
  useEffect(() => () => useAdContinue.getState().reset(), []);

  return <AdContinueView stage={stage} locked={props.locked} wide={props.wide} onWatch={() => void useAdContinue.getState().watch()} />;
}

/**
 * Само отображение — без сети и стора: его же показывает витрина
 * компонентов. Рендерит ячейки сетки блока «Второй шанс»: кнопку и строку
 * состояния на всю ширину. Кнопки нет, когда за рекламу продолжить нельзя, —
 * строка остаётся, если игроку есть что сказать.
 */
export function AdContinueView(props: { stage: AdContinueStage; locked: boolean; wide: boolean; onWatch(): void }): ReactNode {
  const { stage } = props;
  const pass = (stage.kind === "ready" || stage.kind === "watching") && stage.pass;
  const line = lineOf(stage);

  return (
    <>
      {stage.kind === "unavailable" ? null : (
        <Button
          block
          variant="secondary"
          loading={stage.kind === "checking" || stage.kind === "watching"}
          disabled={stage.kind !== "ready" || props.locked}
          ariaLabel={t(pass ? "run.continue.vip" : "run.continue.ad")}
          onClick={props.onWatch}
        >
          {pass ? <Crown size={18} aria-hidden="true" /> : <Tv size={18} aria-hidden="true" />}
          {/* Рядом с кнопкой звёзд — коротко: колонка экрана смерти узкая, и
              «За рекламу» переносилась на две строки. Одна — целиком. */}
          {t(pass ? (props.wide ? "run.continue.vip" : "run.continue.vip.short") : props.wide ? "run.continue.ad" : "run.continue.ad.short")}
        </Button>
      )}
      {line === null ? null : (
        <p className="col-span-full text-xs text-text-muted" role="status">
          {line}
        </p>
      )}
    </>
  );
}

function lineOf(stage: AdContinueStage): string | null {
  if (stage.kind === "ready" && stage.notice !== null) return t(`run.continue.ad.notice.${stage.notice}`);
  // Остальные отказы — молча: рекламы для площадки нет или продолжение уже взято.
  if (stage.kind === "unavailable" && (stage.reason === "daily_cap" || stage.reason === "no_ads_now")) return t(`run.continue.ad.gone.${stage.reason}`);
  return null;
}
