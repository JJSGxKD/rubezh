import type { ReactNode } from "react";
import { Check, Lock } from "lucide-react";
import { Badge, Button, Card, ProgressBar } from "../../design-system/components";
import { formatNumber, t } from "../../i18n";
import "../../i18n/tasks";
import type { PointsPeriod } from "../../state/tasks-api";
import { barFill, leftToNext, markers, type PointsBar, type PointsStep } from "./task-points-rules";
import { RewardChips } from "./task-reward";

/**
 * Полоса очков дня и недели над списком заданий (docs/39-retention-mechanics.md
 * П2, tasks/T-0105): сумма очков, три ступени с наградой и «до награды ещё N
 * очков». Что набрано и что можно забрать, решает сервер; здесь — только
 * показ и нажатие «Забрать».
 *
 * Заполнение — готовая `ProgressBar`: `transform: scaleX` на токенах движения,
 * поэтому «меньше движения» собирает полосу сразу, как и остальные полосы.
 */
export function TaskPointsBar(props: {
  period: PointsPeriod;
  bar: PointsBar;
  /** порог ступени, которую сейчас забирают: на время запроса кнопка не нажимается */
  claiming: number | null;
  /** отказ или результат забора — строка под полосой */
  notice: string | null;
  onClaim: (points: number) => void;
}): ReactNode {
  const { period, bar } = props;
  const left = leftToNext(bar);
  const total = t("tasks.points.total", { points: formatNumber(bar.total) });

  return (
    <Card>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-display text-sm font-bold text-text">{t(`tasks.points.${period}`)}</span>
        <span className="font-display text-sm font-bold tabular-nums text-accent">{total}</span>
      </div>
      <div className="relative mt-2">
        <ProgressBar value={barFill(bar.total, bar.steps) * 1000} max={1000} label={`${t(`tasks.points.${period}`)}: ${total}`} />
        {/* Ступени отмечены чёрточками: место — доля порога от последнего, не цвет. */}
        {markers(bar.steps).map((share, index) => (
          <span key={bar.steps[index]?.points ?? index} aria-hidden="true" className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-border-strong" style={{ left: `${(share * 100).toFixed(2)}%` }} />
        ))}
      </div>
      <ul className="mt-3 grid grid-cols-3 gap-2">
        {bar.steps.map((step) => (
          <li key={step.points}>
            <StepCell step={step} busy={props.claiming === step.points} disabled={props.claiming !== null} onClaim={() => props.onClaim(step.points)} />
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs font-semibold text-text-muted">{left === null ? t(`tasks.points.allDone.${period}`) : t("tasks.points.left", { left })}</p>
      {period === "weekly" ? <p className="mt-0.5 text-xs text-text-muted">{t("tasks.points.weeklyHint")}</p> : null}
      {props.notice === null ? null : <p className="mt-2 text-xs font-semibold text-text-muted">{props.notice}</p>}
    </Card>
  );
}

function StepCell(props: { step: PointsStep; busy: boolean; disabled: boolean; onClaim: () => void }): ReactNode {
  const { step } = props;
  return (
    <div
      className={["flex h-full flex-col items-center gap-1.5 rounded-md p-2 text-center", step.state === "ready" ? "bg-accent/15 ring-1 ring-accent/60" : "bg-surface-raised"].join(" ")}
      // Метка — откуда вылетает награда при заборе (`reward-burst.tsx`).
      data-points-reward={step.points}
    >
      <span className={["font-display text-xs font-bold tabular-nums", step.state === "locked" ? "text-text-muted" : "text-text"].join(" ")}>{t("tasks.points.total", { points: formatNumber(step.points) })}</span>
      <RewardChips reward={step.reward} inline />
      {step.state === "ready" ? (
        <Button track="claim_points" size="s" block loading={props.busy} disabled={props.disabled && !props.busy} onClick={props.onClaim}>
          {t("tasks.claim")}
        </Button>
      ) : step.state === "claimed" ? (
        <Badge tone="muted">
          <Check size={12} aria-hidden="true" />
          {t("tasks.claimed")}
        </Badge>
      ) : (
        <Lock size={16} aria-hidden="true" className="mt-0.5 text-text-muted" />
      )}
    </div>
  );
}
