import { api } from "../../services";
import { fetchReviewQueue } from "../../api/review";
import { formatDateTime, formatDuration, formatNumber } from "../../format";
import { Badge, Button, DataTable, ErrorNotice, Loading, Panel } from "../../ui/kit";
import { navigate } from "../../ui/router";
import { useApi } from "../../ui/use-api";

/**
 * Очередь разбора: забеги, которые проверка сервера сочла подозрительными
 * или отклонила. Строка ведёт в карточку игрока — разбирают человека, а не
 * один забег.
 */
export function ReviewScreen() {
  const { state, reload } = useApi(() => fetchReviewQueue(api), []);
  return (
    <Panel title="Разбор забегов" actions={<Button onClick={reload}>Обновить</Button>}>
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {state.status === "ok" ? (
        <DataTable
          rows={state.data.runs}
          rowKey={(run) => run.runId}
          onRowClick={(run) => navigate({ section: "players", id: run.accountId })}
          empty="Очередь пуста"
          columns={[
            { title: "Закончен", render: (run) => formatDateTime(run.finishedAt) },
            { title: "Вердикт", render: (run) => <Badge tone={run.verdict === "rejected" ? "danger" : "warning"}>{run.verdict === "rejected" ? "отклонён" : "подозрительный"}</Badge> },
            { title: "Причины", render: (run) => run.verdictReasons.join(", ") || "—" },
            { title: "Сложность", render: (run) => run.difficulty },
            { title: "Время", render: (run) => (run.survivalSec === null ? "—" : formatDuration(run.survivalSec)), align: "right" },
            { title: "Уровень", render: (run) => run.level ?? "—", align: "right" },
            { title: "Убийств", render: (run) => (run.enemiesKilled === null ? "—" : formatNumber(run.enemiesKilled)), align: "right" },
            { title: "Забег", render: (run) => <code className="text-xs text-text-muted">{run.runId.slice(0, 8)}</code> },
          ]}
        />
      ) : null}
    </Panel>
  );
}
