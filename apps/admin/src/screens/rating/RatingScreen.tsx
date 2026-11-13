import { useState } from "react";
import { api } from "../../services";
import { fetchRatingBoards, fetchSeasons, PAGE_SIZE, PERIOD_TITLES, scoreText, weekTitle, divisionTitle, type RatingBoard, type RatingDifficulty, type RatingPeriod, type SeasonCard } from "../../api/rating";
import { formatDateTime, formatNumber } from "../../format";
import { can } from "../../state/session";
import { useSession } from "../../state/use-session";
import { HELP } from "../../ui/help";
import { Button, DataTable, ErrorNotice, Loading, Panel, Select } from "../../ui/kit";
import { navigate } from "../../ui/router";
import { useApi } from "../../ui/use-api";
import { BoardSelect, DifficultySelect, PlayerLink } from "./controls";
import { SeasonView } from "./SeasonView";

/**
 * Раздел «Рейтинг» (tasks/T-0381, docs/35-stage4-plan.md Р189): доски сейчас и
 * архив недельных сезонов; с ключом сезона в адресе — итоги этого сезона.
 */
export function RatingScreen({ id, tab }: { id: string | null; tab?: string | undefined }) {
  if (id !== null) return <SeasonView key={id} seasonKey={id} tab={tab} />;
  return (
    <div className="flex flex-col gap-4">
      <BoardsPanel />
      <ArchivePanel />
    </div>
  );
}

function BoardsPanel() {
  const view = useSession((session) => session.view);
  const canFull = can(view, "players.board.restrict");
  const [period, setPeriod] = useState<RatingPeriod>("week");
  const [difficulty, setDifficulty] = useState<RatingDifficulty>("hard");
  const [picked, setPicked] = useState<RatingBoard>("common");
  const board = canFull ? picked : "common";
  const { state, reload } = useApi(() => fetchRatingBoards(api, { difficulty, period, board, limit: PAGE_SIZE }), [difficulty, period, board]);

  const data = state.status === "ok" ? state.data : null;
  return (
    <Panel title="Доски сейчас" help={HELP.rating.section}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-1.5">
            Период
            <Select
              value={period}
              onChange={(event) => setPeriod(event.target.value === "all" ? "all" : "week")}
            >
              {(Object.keys(PERIOD_TITLES) as RatingPeriod[]).map((key) => (
                <option key={key} value={key}>
                  {PERIOD_TITLES[key]}
                </option>
              ))}
            </Select>
          </label>
          <DifficultySelect value={difficulty} onChange={setDifficulty} />
          {canFull ? <BoardSelect value={picked} onChange={setPicked} /> : null}
        </div>
        {state.status === "loading" ? <Loading /> : null}
        {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
        {data === null ? null : (
          <>
            <p className="text-sm text-text-muted">
              {period === "all"
                ? "Всё время · по очкам"
                : data.seasonKey === null
                  ? "Сезон не идёт — доска недели появится с его началом"
                  : `Неделя ${weekTitle(data.seasonKey)} · по ${data.scoring === "time" ? "времени" : "очкам"}`}
            </p>
            <DataTable
              rows={data.entries}
              rowKey={(row) => `${String(row.place)}-${row.accountId}`}
              empty={period === "week" && data.seasonKey === null ? "Сезон не идёт — доска недели появится с его началом" : "На этой доске пока никого"}
              columns={[
                { title: "Место", render: (row) => row.place, align: "right" },
                { title: "Игрок", render: (row) => <PlayerLink accountId={row.accountId} name={row.name} />, primary: true },
                { title: "Результат", render: (row) => scoreText(row.score, data.scoring), align: "right" },
                { title: "Время", render: (row) => scoreText(row.survivalSec, "time"), align: "right" },
                ...(period === "week" ? [{ title: "Дивизион", help: HELP.rating.division, render: (row: (typeof data.entries)[number]) => divisionTitle(row.division) }] : []),
              ]}
            />
            <p className="text-xs text-text-muted">Всего на доске: {formatNumber(data.total)}</p>
          </>
        )}
      </div>
    </Panel>
  );
}

function ArchivePanel() {
  const [extra, setExtra] = useState<{ seasons: SeasonCard[]; next: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const { state, reload } = useApi(() => fetchSeasons(api, null), []);

  const first = state.status === "ok" ? state.data : null;
  const rows = first === null ? [] : [...first.seasons, ...(extra?.seasons ?? [])];
  const next = first === null ? null : extra === null ? first.next : extra.next;

  const more = async () => {
    if (next === null) return;
    setLoadingMore(true);
    setMoreError(null);
    const result = await fetchSeasons(api, next);
    setLoadingMore(false);
    if (!result.ok) return setMoreError(result.error.message);
    setExtra({ seasons: [...(extra?.seasons ?? []), ...result.data.seasons], next: result.data.next });
  };

  return (
    <Panel title="Архив сезонов" help={HELP.rating.section}>
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {first === null ? null : (
        <div className="flex flex-col gap-3">
          <DataTable
            rows={rows}
            rowKey={(row) => row.key}
            onRowClick={(row) => navigate({ section: "rating", id: row.key })}
            empty="Закрытых сезонов ещё нет"
            columns={[
              { title: "Неделя", render: (row) => weekTitle(row.key), primary: true },
              { title: "Игроков", render: (row) => formatNumber(row.players), align: "right" },
              { title: "С наградой", render: (row) => formatNumber(row.rewarded), align: "right" },
              { title: "Считали по", render: (row) => (row.scoring === "time" ? "времени" : "очкам") },
              { title: "Закрыт", render: (row) => <span className="whitespace-nowrap">{formatDateTime(row.closedAt)}</span> },
            ]}
          />
          {moreError === null ? null : <p className="text-sm text-danger">{moreError}</p>}
          {next === null ? null : (
            <div>
              <Button disabled={loadingMore} onClick={() => void more()}>
                {loadingMore ? "Загружаем…" : "Показать ещё"}
              </Button>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

