import { useEffect, useRef, type ReactNode } from "react";
import { Crown, Skull } from "lucide-react";
import type { RunResult } from "@bh/shared-types";
import { Button, Modal } from "../../design-system/components";
import { t } from "../../i18n";
import "../../i18n/run";
// Строки награды — в словаре аккаунта: он приезжает с этим чанком, а не с
// первой загрузкой.
import "../../i18n/account";
import { useMeta } from "../../state/meta";
import { useProgress, type RunRewardView } from "../../state/progress";
import { awaitReward } from "../../state/progress-api";
import { useRuns } from "../../state/runs";
import { DeathNext } from "./DeathNext";
import { ChanceStep, LevelUpCard, ResultsHero, RewardCard, RunDetails, RunStats } from "./death-parts";
import { deathStep } from "./death-rules";
import { guarded, useTapGuard } from "./overlay-guard";
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
  onShare(): void;
}

export function DeathOverlay(props: DeathOverlayProps): ReactNode {
  const ready = useTapGuard();
  const { result } = props;
  const stored = useProgress((state) => state.rewards[result.runId]);
  const reward = props.reward ?? (props.showReward === true ? stored : undefined);
  const detailsOpen = useMeta((state) => state.deathDetailsOpen);
  // Награду считает сервер после ответа на итог — спрашиваем, как только итог
  // этого забега принят. Экран ушёл раньше — опрос доработает сам и обновит
  // шапку.
  const accepted = useRuns((state) => state.lastSubmitted?.runId === result.runId);
  useEffect(() => {
    if (props.showReward === true && accepted && useProgress.getState().rewards[result.runId] === undefined) void awaitReward(result.runId);
  }, [props.showReward, accepted, result.runId]);

  // Второй шанс — только пока забег ждёт решения: сданный забег игрок
  // закончил сам, а закрытый смертью продолжить уже нечем.
  const { secondChance } = props;
  const waiting = result.outcome === "died" && secondChance !== undefined;
  const hasWays = secondChance !== undefined && (secondChance.onDevContinue !== undefined || secondChance.paidFor !== undefined || secondChance.adFor !== undefined);
  const step = deathStep({ phase: waiting ? "downed" : "finished", hasWays });
  const downedWithoutWays = waiting && !hasWays;

  // Продолжить нечем — шага со вторым шансом нет: забег закрывается смертью,
  // как и когда способы отпали сами. Итоги появятся, когда он закроется.
  const { onDecline } = props;
  const declined = useRef(false);
  useEffect(() => {
    if (!downedWithoutWays || declined.current) return;
    declined.current = true;
    onDecline();
  }, [downedWithoutWays, onDecline]);

  if (step === "chance" && secondChance !== undefined) {
    return (
      <Modal>
        <ChanceStep result={result} secondChance={secondChance} onDecline={guarded(ready, onDecline)} />
      </Modal>
    );
  }

  const actions = (
    <>
      <Button size="l" block glow loading={props.restarting === true} onClick={guarded(ready, props.onRestart)}>
        {t("run.death.again")}
      </Button>
      {/* До 360 px подписи пары не помещаются в одну строку при штатных полях и шрифте. */}
      <div className="grid grid-cols-2 gap-2 max-[22.5rem]:[&>button]:px-3 max-[22.5rem]:[&>button]:text-sm landscape:contents">
        <Button variant="secondary" block onClick={props.onMenu}>
          {t("run.death.home")}
        </Button>
        <Button variant="ghost" block onClick={props.onShare}>
          {t("run.death.share")}
        </Button>
      </div>
    </>
  );

  return (
    <Modal
      title={result.outcome === "died" ? t("run.death.title") : t("run.death.abandoned")}
      icon={props.isNewRecord ? <RecordCrown /> : <Skull size={26} />}
      size="l"
      cut
      pinFooter
      // Кнопки закреплены внизу окна: при любом числе карточек видны все три.
      // В портрете «Ещё раз» и пара под ней, в ландшафте — один ряд из трёх
      // (docs/27-design-system-and-app-shell.md §5.3).
      footer={<div className="grid gap-2 landscape:grid-cols-[2fr_1fr_1fr]">{actions}</div>}
    >
      {/* Прокрутка одна — тело модалки: окно не выше экрана, а карточки
          уходят под неё, не унося за край кнопки. */}
      <div>
        <div className="grid gap-4 landscape:grid-cols-2">
          <div className="grid content-start gap-3">
            <ResultsHero result={result} isNewRecord={props.isNewRecord} {...(props.rank === undefined ? {} : { rank: props.rank })} {...(props.cheatsCounted === undefined ? {} : { cheatsCounted: props.cheatsCounted })} />
            {/* Удвоение — только у настоящего итога: у витрины компонентов сети нет. */}
            {reward === undefined ? null : <RewardCard reward={reward} {...(props.showReward === true ? { doubleRunId: result.runId } : {})} />}
            {reward?.status === "granted" ? <LevelUpCard levelBefore={reward.levelBefore} levelAfter={reward.levelAfter} /> : null}
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

/**
 * Корона нового рекорда с лучами за ней — тот же веер, что за сундуком
 * (`effects.md` §6.1): рекорд — награда, и выглядит наградой. Лучи — за
 * кругом значка, вращается слой целиком (только `transform`).
 */
function RecordCrown(): ReactNode {
  return (
    <>
      <span aria-hidden="true" className="pointer-events-none absolute top-1/2 left-1/2 -z-10 -mt-22 -ml-22 size-44">
        <span className="block size-full animate-chest-rays-in">
          <span
            className="block size-full animate-chest-rays-spin rounded-full"
            style={{
              backgroundImage: "repeating-conic-gradient(from 0deg, color-mix(in oklab, var(--color-accent) 32%, transparent) 0deg 7deg, transparent 7deg 22deg)",
              maskImage: "radial-gradient(closest-side, black 30%, transparent 85%)",
            }}
          />
        </span>
      </span>
      <Crown size={28} />
    </>
  );
}
