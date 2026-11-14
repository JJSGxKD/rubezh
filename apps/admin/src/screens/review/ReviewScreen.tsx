import { useState } from "react";
import { api } from "../../services";
import { VERDICT_FILTERS, difficultyTitle, fetchReviewQueue, reasonTitle, runsPerPlayer, type ReviewRow, type VerdictFilter } from "../../api/review";
import { formatDateTime, formatDuration, formatNumber } from "../../format";
import { Badge, Button, DataTable, ErrorNotice, Loading, Panel } from "../../ui/kit";
import { HELP } from "../../ui/help";
import { BoardMarkBadge } from "./review-parts";
import { navigate, useHashRoute } from "../../ui/router";
import { useApi } from "../../ui/use-api";
import { RunReport } from "./RunReport";
import { replayBadge, replayTickText, reviewView } from "./run-report-view";

/**
 * Раздел «Разбор забегов»: адрес `#/review` — очередь, `#/review/<забег>` —
 * отчёт этого забега (Р203, tasks/T-0420).
 */
export function ReviewScreen() {
  const runId = useHashRoute()?.id ?? null;
  return reviewView(runId) === "report" && runId !== null ? <RunReport key={runId} runId={runId} /> : <ReviewQueue />;
}

/**
 * Очередь разбора: забеги, которые проверка сервера сочла подозрительными
 * или отклонила. Строка открывает отчёт забега, а в карточку игрока ведёт
 * ссылка на отчёте; рядом с именем — сколько ещё забегов этого игрока в
 * очереди: повтор — сильнее повод разобраться, чем один забег.
 */
function ReviewQueue() {
  const { state, reload } = useApi(() => fetchReviewQueue(api), []);
  const [filter, setFilter] = useState<VerdictFilter>("all");

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const all = state.data.runs;
  const perPlayer = runsPerPlayer(all);
  const rows = filter === "all" ? all : all.filter((run) => run.verdict === filter);
  const count = (id: VerdictFilter) => (id === "all" ? all.length : all.filter((run) => run.verdict === id).length);

  return (
    <Panel title="Разбор забегов" help={HELP.review.queue} actions={<Button onClick={reload}>Обновить</Button>}>
      <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Вердикт">
        {VERDICT_FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={filter === item.id}
            onClick={() => setFilter(item.id)}
            className={`rounded-pill border px-3 py-1 text-xs transition-colors ${filter === item.id ? "border-accent bg-accent/15 text-accent" : "border-border text-text-muted hover:border-border-strong hover:text-text"}`}
          >
            {item.title} <span>{count(item.id)}</span>
          </button>
        ))}
      </div>
      <DataTable
        rows={rows}
        rowKey={(run) => run.runId}
        onRowClick={(run) => navigate({ section: "review", id: run.runId })}
        empty={all.length === 0 ? "Очередь пуста — проверка сервера ни к одному забегу вопросов не имеет" : "В этом отборе пусто"}
        columns={[
          { title: "Закончен", render: (run) => <span className="whitespace-nowrap">{formatDateTime(run.finishedAt)}</span> },
          { title: "Игрок", render: (run) => <PlayerCell run={run} more={(perPlayer.get(run.accountId) ?? 1) - 1} /> },
          { title: "Вердикт", render: (run) => <Badge tone={run.verdict === "rejected" ? "danger" : "warning"}>{run.verdict === "rejected" ? "отклонён" : "подозрительный"}</Badge> },
          { title: "Причины", help: HELP.review.reasons, render: (run) => run.verdictReasons.map(reasonTitle).join("; ") || "—" },
          { title: "Повтор", render: (run) => <ReplayCell run={run} /> },
          { title: "Сложность", render: (run) => difficultyTitle(run.difficulty) },
          { title: "Время", render: (run) => (run.survivalSec === null ? "—" : formatDuration(run.survivalSec)), align: "right" },
          { title: "Уровень", render: (run) => run.level ?? "—", align: "right" },
          { title: "Убийств", render: (run) => (run.enemiesKilled === null ? "—" : formatNumber(run.enemiesKilled)), align: "right" },
          { title: "Забег", render: (run) => <code className="text-xs text-text-muted">{run.runId.slice(0, 8)}</code> },
        ]}
      />
    </Panel>
  );
}

function PlayerCell({ run, more }: { run: ReviewRow; more: number }) {
  return (
    <span className="flex flex-col">
      <span>{run.displayName ?? <code className="text-xs text-text-muted">{run.accountId.slice(0, 8)}</code>}</span>
      {more > 0 ? <span className="text-xs text-warning">ещё {more} в очереди</span> : null}
      <BoardMarkBadge run={run} />
    </span>
  );
}

/** Исход перепроверки повтором и тик расхождения: у забега, которому повтор не назначали, прочерк. */
function ReplayCell({ run }: { run: ReviewRow }) {
  if (run.replay === undefined) return <span className="text-text-muted">—</span>;
  const badge = replayBadge(run.replay.verdict);
  return (
    <span className="flex flex-col items-start gap-0.5">
      <Badge tone={badge.tone}>{badge.text}</Badge>
      {run.replay.divergedTick === null ? null : <span className="text-xs text-text-muted">{replayTickText(run.replay.divergedTick)}</span>}
    </span>
  );
}
