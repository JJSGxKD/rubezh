import { useEffect, useId, useState, type ReactNode } from "react";
import type { RunResult } from "@bh/shared-types";
import { Button, Modal, RibbonTitle } from "../../design-system/components";
import { CoinIcon, GemIcon } from "../../design-system/components/CurrencyIcons";
import { formatDuration, formatNumber, t } from "../../i18n";
import "../../i18n/run";
import { settlePrologueWin, type PrologueReward } from "../../state/prologue";
import { ResultsMedallion } from "./death-parts";
import { guarded, useTapGuard } from "./overlay-guard";
import { resultsLook } from "./results-look";

/**
 * Окно «Рубеж удержан!» (tasks/T-0280, Р151): первая победа аккаунта. Окно-реликвия
 * итогов (T-0232): лента с заголовком, медальон, время героем, награда с
 * сервера, что открылось и цель впереди. Окна смерти у пролога нет — победа
 * приходит от движка как закрытый забег, и экран забега показывает это окно
 * вместо итогов (`RunScreen.tsx`).
 *
 * Награду выдаёт сервер, а числа читаются из его журнала (`state/prologue.ts`):
 * панель вправе их менять, и постоянные в клиенте разошлись бы с кошельком.
 */

export interface PrologueWinViewProps {
  result: RunResult;
  reward: PrologueReward;
  onHome(): void;
}

/** Окно без запросов: то, что видит игрок, по готовому итогу и награде — для витрины и тестов. */
export function PrologueWinView(props: PrologueWinViewProps): ReactNode {
  const ready = useTapGuard();
  const titleId = useId();
  // Тон и медальон — те же, что у итогов с победой: золото победы берётся у функции облика итога, а не пишется заново.
  const look = resultsLook(props.result.outcome, true, true);

  return (
    <Modal
      labelledBy={titleId}
      relic={look.tone}
      size="m"
      pinFooter
      footer={
        <Button track="prologue_home" size="l" block glow onClick={guarded(ready, props.onHome)}>
          {t("run.prologue.home")}
        </Button>
      }
    >
      <div className="mt-1 mb-3 flex items-center justify-center gap-2 short:mb-2">
        <ResultsMedallion icon={look.icon} tone={look.tone} />
        <RibbonTitle id={titleId} tone={look.tone}>
          {t("run.prologue.title")}
        </RibbonTitle>
      </div>

      <div className="grid gap-3 text-center">
        <div>
          <div className="font-display text-[46px] leading-none tabular-nums text-text short:text-[38px]">{formatDuration(props.result.survivalSec)}</div>
          <div className="mt-1 text-xs text-text-muted">{t("run.death.survived")}</div>
        </div>

        <RewardLines reward={props.reward} />

        <p className="text-sm text-text">{t("run.prologue.opened")}</p>
        <p className="surface-sunken rounded-lg px-3 py-2 text-[13px] text-text-muted">{t("run.prologue.goal")}</p>
      </div>
    </Modal>
  );
}

/** Награда: пока считается — тихая строка, нет связи — обещание, нет начисления — ничего. */
function RewardLines(props: { reward: PrologueReward }): ReactNode {
  const { reward } = props;
  if (reward.status === "pending") return <p className="text-xs text-text-muted">{t("run.prologue.pending")}</p>;
  if (reward.status === "offline") return <p className="text-sm text-text-muted">{t("run.prologue.offline")}</p>;
  if (reward.status === "none") return null;
  return (
    <div className="surface-sunken flex animate-rise-in flex-wrap items-center justify-center gap-x-5 gap-y-2 rounded-lg px-3 py-3">
      {reward.coins > 0 ? (
        <span className="inline-flex items-center gap-1.5 font-display text-xl leading-none tabular-nums text-text">
          <CoinIcon size={20} />
          {t("run.prologue.coins", { amount: formatNumber(reward.coins) })}
        </span>
      ) : null}
      {reward.gems > 0 ? (
        <span className="inline-flex items-center gap-1.5 font-display text-xl leading-none tabular-nums text-text">
          <GemIcon size={20} />
          {t("run.prologue.gems", { amount: formatNumber(reward.gems) })}
        </span>
      ) : null}
    </div>
  );
}

/** Окно победы: ждёт награду сервера и ведёт на главную. */
export function PrologueWin(props: { result: RunResult; onHome(): void }): ReactNode {
  const { runId } = props.result;
  const [reward, setReward] = useState<PrologueReward>({ status: "pending" });

  useEffect(() => {
    let alive = true;
    settlePrologueWin(runId).then(
      (settled) => {
        if (alive) setReward(settled);
      },
      () => {
        // Сеть и сервер моргнули — награда придёт сама, когда итог дойдёт.
        if (alive) setReward({ status: "offline" });
      },
    );
    return () => {
      alive = false;
    };
  }, [runId]);

  return <PrologueWinView result={props.result} reward={reward} onHome={props.onHome} />;
}
