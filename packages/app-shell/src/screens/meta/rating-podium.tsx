import type { ReactNode } from "react";
import { Crown } from "lucide-react";
import type { LeaderboardEntry } from "@bh/shared-types";
import { Avatar, staggerStyle } from "../../design-system/components";
import { formatDuration, formatNumber, t } from "../../i18n";
import "../../i18n/season";
import { podiumSteps, scoreOf, type Scoring } from "./rating-rules";
import { RowOpener, entryRunId } from "./run-card-link";

/**
 * Пьедестал топ-3 (tasks/T-0296, Р66, `design/art/meta-v2.md` §2.4): рейтинг —
 * витрина игроков. Пока облики T-0238 не подключены, вместо облика целиком —
 * нынешний аватар крупно (Р184). Слева направо 2 · 1 · 3, высота ступени — по
 * месту; имя и главное число под аватаром, номер места — на ступени. Игроков
 * меньше трёх — столько ступеней, сколько есть.
 */

/** Ступень каждого места: высота из шкалы отступов, тон кромки и номера — места на стандартной марке рейтинга. */
const STEP_LOOK = {
  1: { block: "h-16 border-elite text-elite", avatar: 64 },
  2: { block: "h-12 border-text-muted text-text-muted", avatar: 52 },
  3: { block: "h-9 border-warning text-warning", avatar: 52 },
} as const;

const COLUMNS: Readonly<Record<number, string>> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3" };

export function Podium(props: { entries: readonly LeaderboardEntry[]; scoring: Scoring }): ReactNode {
  const steps = podiumSteps(props.entries);
  if (steps.length === 0) return null;

  return (
    <ol aria-label={t("rating.podium")} className={`surface-card grid items-end gap-2 overflow-hidden rounded-lg px-3 pt-4 ${COLUMNS[steps.length] ?? "grid-cols-3"}`}>
      {steps.map((step, index) => {
        const look = STEP_LOOK[step.place];
        const score = scoreOf(step.entry, props.scoring);
        const runId = entryRunId(step.entry);
        return (
          <li key={step.place} data-place={step.place} className="relative flex min-w-0 animate-rise-in flex-col items-center" style={staggerStyle(index)}>
            {runId === null ? null : <RowOpener runId={runId} name={step.entry.name} />}
            {step.place === 1 ? <Crown size={18} aria-hidden="true" className="mb-1 text-elite" /> : null}
            <Avatar name={step.entry.name} url={step.entry.photoUrl} size={look.avatar} />
            <span className={`mt-1.5 max-w-full truncate font-display text-sm font-bold ${step.entry.isMe ? "text-accent" : "text-text"}`}>{step.entry.name}</span>
            <span className="font-display text-sm tabular-nums text-text-muted">
              <span aria-hidden={score.kind === "points" ? "true" : undefined}>{score.kind === "points" ? formatNumber(score.value) : formatDuration(score.value)}</span>
              {score.kind === "points" ? <span className="sr-only">{t("rating.points.sr", { points: formatNumber(score.value) })}</span> : null}
            </span>
            <span className={`mt-2 flex w-full items-start justify-center rounded-t-lg border-t-2 bg-surface-raised pt-1 font-display text-xl font-bold ${look.block}`}>{step.place}</span>
          </li>
        );
      })}
    </ol>
  );
}
