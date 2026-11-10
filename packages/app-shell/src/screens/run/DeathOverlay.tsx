import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { RunResult } from "@bh/shared-types";
import { Button, Modal, RibbonTitle } from "../../design-system/components";
import { t } from "../../i18n";
import "../../i18n/run";
// Строки награды — в словаре аккаунта: он приезжает с этим чанком, а не с
// первой загрузкой.
import "../../i18n/account";
import { useMeta } from "../../state/meta";
import { currentScreen, useNavigation } from "../../state/navigation";
import { useProgress, type RunRewardView } from "../../state/progress";
import { awaitReward } from "../../state/progress-api";
import { useRuns } from "../../state/runs";
import { RunScoreLink } from "../meta/run-card-link";
import { DeathNext } from "./DeathNext";
import { RubezhResult } from "./RubezhResult";
import { ChanceStep, LevelUpCard, ResultsHero, ResultsMedallion, RewardCard, RunDetails, RunStats } from "./death-parts";
import { deathStep } from "./death-rules";
import { guarded, useTapGuard } from "./overlay-guard";
import { resultsLook } from "./results-look";
import type { SecondChanceProps } from "./SecondChance";

/**
 * Экран смерти в два шага (design/screens/death.html, решения от 07.10.2026).
 * Шаг 1 — пока забег ждёт решения о втором шансе и есть способы продолжить:
 * короткое окно с ним одним. Шаг 2 — итоги: время героем, награда, подробности
 * по кнопке. Отдельный чанк (`death-overlay-lazy.tsx`): до первой смерти он не
 * нужен, а весит как треть оверлеев, и первая загрузка за него не платит
 * (docs/27-design-system-and-app-shell.md §3.4).
 */

export interface DeathOverlayProps {
  result: RunResult;
  isNewRecord: boolean;
  /** место в рейтинге плейтеста; нет — сервер ещё не ответил или его нет */
  rank?: number | null;
  diagnostics: boolean;
  /** забег с читами учтён в рейтинге по просьбе администратора */
  cheatsCounted?: boolean;
  /**
   * Забег ждёт решения о втором шансе: итог предварительный. Без поля —
   * забег закрыт, и блока второго шанса нет: продолжать уже нечего.
   */
  secondChance?: SecondChanceProps;
  /**
   * Показать награду за забег с сервера (docs/35-stage4-plan.md, WP4) — когда
   * забег закрыт. Подписка на награду живёт здесь, в ленивом чанке экрана, а
   * не в экране забега: первая загрузка за неё не платит.
   */
  showReward?: boolean;
  /** награда напрямую — для витрины компонентов */
  reward?: RunRewardView;
  /** «Ещё раз» нажато, и новый забег ждёт межстраничную: кнопка крутится, второе нажатие не нужно */
  restarting?: boolean;
  /** отказ от второго шанса: забег закрывается смертью, и экран переходит к итогам */
  onDecline(): void;
  onRestart(): void;
  onMenu(): void;
  /** строка под кнопками — что вышло, когда это не видно само; null — говорить нечего */
  onShare(): Promise<string | null>;
}

export function DeathOverlay(props: DeathOverlayProps): ReactNode {
  const ready = useTapGuard();
  const titleId = useId();
  const { result } = props;
  const stored = useProgress((state) => state.rewards[result.runId]);
  const reward = props.reward ?? (props.showReward === true ? stored : undefined);
  const detailsOpen = useMeta((state) => state.deathDetailsOpen);
  // Награду считает сервер после ответа на итог — спрашиваем, как только итог
  // этого забега принят. Экран ушёл раньше — опрос доработает сам и обновит
  // шапку.
  const accepted = useRuns((state) => state.lastSubmitted?.runId === result.runId);
  // Очки этого забега — из ответа сервера на итог; строка ведёт в карточку забега (tasks/T-0297).
  const score = useRuns((state) => (state.lastSubmitted?.runId === result.runId ? state.lastSubmitted.result.score : undefined));
  // Карточка забега ложится поверх забега как экран, а окно итогов живёт в слое модалок выше экранов:
  // пока карточка открыта, окно убирается (хуки остаются на месте, состояние окна не теряется).
  const covered = useNavigation((state) => state.stack.includes("run") && currentScreen(state.stack) !== "run");
  useEffect(() => {
    if (props.showReward === true && accepted && useProgress.getState().rewards[result.runId] === undefined) void awaitReward(result.runId);
  }, [props.showReward, accepted, result.runId]);

  // Второй шанс — только пока забег ждёт решения: сданный забег игрок
  // закончил сам, а закрытый смертью продолжить уже нечем.
  const { secondChance } = props;
  const waiting = result.outcome === "died" && secondChance !== undefined;
  const hasWays = secondChance !== undefined && (secondChance.onDevContinue !== undefined || secondChance.paidFor !== undefined || secondChance.adFor !== undefined || secondChance.gemsFor !== undefined);
  const step = deathStep({ phase: waiting ? "downed" : "finished", hasWays });
  const downedWithoutWays = waiting && !hasWays;

  // Продолжить нечем — шага со вторым шансом нет: забег закрывается смертью,
  // как и когда способы отпали сами. Итоги появятся, когда он закроется.
  const { onDecline, onShare } = props;
  const declined = useRef(false);
  useEffect(() => {
    if (!downedWithoutWays || declined.current) return;
    declined.current = true;
    onDecline();
  }, [downedWithoutWays, onDecline]);

  // Ответ площадки ждём на месте: второе нажатие, пока выбор чата
  // открывается, отправило бы итог дважды.
  const [share, setShare] = useState<{ busy: boolean; note: string | null }>({ busy: false, note: null });
  const runShare = (): void => {
    if (share.busy) return;
    setShare({ busy: true, note: null });
    onShare().then(
      (note) => setShare({ busy: false, note }),
      () => setShare({ busy: false, note: t("error.title") }),
    );
  };

  if (covered) return null;

  if (step === "chance" && secondChance !== undefined) {
    return (
      <Modal>
        <ChanceStep result={result} secondChance={secondChance} onDecline={guarded(ready, onDecline)} />
      </Modal>
    );
  }

  const look = resultsLook(result.outcome, props.isNewRecord, result.rubezh?.clearedSec != null);

  const actions = (
    <>
      <Button track="restart" size="l" block glow loading={props.restarting === true} onClick={guarded(ready, props.onRestart)}>
        {t("run.death.again")}
      </Button>
      {/* До 360 px подписи пары не помещаются в одну строку при штатных полях и шрифте. */}
      <div className="grid grid-cols-2 gap-2 max-[22.5rem]:[&>button]:px-3 max-[22.5rem]:[&>button]:text-sm landscape:contents">
        <Button track="home" variant="secondary" block onClick={props.onMenu}>
          {t("run.death.home")}
        </Button>
        <Button track="share" variant="ghost" block loading={share.busy} onClick={runShare}>
          {t("run.death.share")}
        </Button>
      </div>
      {share.note === null ? null : (
        <p role="status" className="text-center text-xs text-text-muted landscape:col-span-full">
          {share.note}
        </p>
      )}
    </>
  );

  return (
    <Modal
      labelledBy={titleId}
      relic={look.tone}
      size="l"
      pinFooter
      // Кнопки закреплены внизу окна: при любом числе карточек видны все три.
      // В портрете «Ещё раз» и пара под ней, в ландшафте — один ряд из трёх
      // (docs/27-design-system-and-app-shell.md §5.3).
      footer={<div className="grid gap-2 landscape:grid-cols-[2fr_1fr_1fr]">{actions}</div>}
    >
      {/* Лента-заголовок с медальоном исхода (T-0232): тон окна говорит, чем кончился забег. */}
      <div className="mt-1 mb-3 flex items-center justify-center gap-2 short:mb-2">
        <ResultsMedallion icon={look.icon} tone={look.tone} />
        <RibbonTitle id={titleId} tone={look.tone} className="max-[22.5rem]:px-4">
          {t(look.titleKey)}
        </RibbonTitle>
      </div>
      {/* Прокрутка одна — тело модалки: окно не выше экрана, а карточки
          уходят под неё, не унося за край кнопки. */}
      <div>
        <div className="grid gap-4 landscape:grid-cols-2">
          <div className="grid content-start gap-3">
            <ResultsHero result={result} isNewRecord={props.isNewRecord} {...(props.rank === undefined ? {} : { rank: props.rank })} {...(props.cheatsCounted === undefined ? {} : { cheatsCounted: props.cheatsCounted })} />
            {score === undefined ? null : <RunScoreLink runId={result.runId} points={score.points} style={score.style} />}
            {/* Удвоение — только у настоящего итога: у витрины компонентов сети нет. */}
            {reward === undefined ? null : <RewardCard reward={reward} {...(props.showReward === true ? { doubleRunId: result.runId } : {})} />}
            {reward?.status === "granted" ? <LevelUpCard levelBefore={reward.levelBefore} levelAfter={reward.levelAfter} /> : null}
            <RubezhResult result={result} reward={reward} />
            <DeathNext result={result} isNewRecord={props.isNewRecord} reward={reward} withTasks={props.showReward === true} />
          </div>
          <div className="grid content-start gap-3">
            <RunStats result={result} />
            <RunDetails result={result} open={detailsOpen} diagnostics={props.diagnostics} onToggle={(open) => useMeta.getState().rememberDeathDetails(open)} />
          </div>
        </div>
      </div>
    </Modal>
  );
}

