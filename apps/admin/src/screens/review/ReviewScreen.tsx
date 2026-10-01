import { useState } from "react";
import { api } from "../../services";
import { VERDICT_FILTERS, difficultyTitle, fetchReviewQueue, reasonTitle, runsPerPlayer, type ReviewRow, type VerdictFilter } from "../../api/review";
import { formatDateTime, formatDuration, formatNumber } from "../../format";
import { Badge, Button, DataTable, ErrorNotice, Loading, Panel } from "../../ui/kit";
import { HELP } from "../../ui/help";
import { navigate } from "../../ui/router";
import { useApi } from "../../ui/use-api";

/**
 * Очередь разбора: забеги, которые проверка сервера сочла подозрительными
 * или отклонила. Строка ведёт в карточку игрока — разбирают человека, а не
 * один забег; поэтому рядом с именем — сколько ещё его забегов в очереди.
 */
export function ReviewScreen() {
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
            {item.title} <span className="opacity-70">{count(item.id)}</span>
          </button>
        ))}
      </div>
      <DataTable
        rows={rows}
        rowKey={(run) => run.runId}
        onRowClick={(run) => navigate({ section: "players", id: run.accountId })}
        empty={all.length === 0 ? "Очередь пуста — проверка сервера ни к одному забегу вопросов не имеет" : "В этом отборе пусто"}
        columns={[
          { title: "Закончен", render: (run) => <span className="whitespace-nowrap">{formatDateTime(run.finishedAt)}</span> },
          { title: "Игрок", render: (run) => <PlayerCell run={run} more={(perPlayer.get(run.accountId) ?? 1) - 1} /> },
          { title: "Вердикт", render: (run) => <Badge tone={run.verdict === "rejected" ? "danger" : "warning"}>{run.verdict === "rejected" ? "отклонён" : "подозрительный"}</Badge> },
          { title: "Причины", help: HELP.review.reasons, render: (run) => run.verdictReasons.map(reasonTitle).join("; ") || "—" },
          { title: "Сложность", render: (run) => difficultyTitle(run.difficulty) },
          { title: "Время", render: (run) => (run.survivalSec === null ? "—" : formatDuration(run.survivalSec)), align: "right" },
          { title: "Уровень", render: (run) => run.level ?? "—", align: "right" },
          { title: "Убийств", render: (run) => (run.enemiesKilled === null ? "—" : formatNumber(run.enemiesKilled)), align: "right" },
          { title: "Забег", render: (run) => <code className="text-xs text-text-disabled">{run.runId.slice(0, 8)}</code> },
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
    </span>
  );
}
