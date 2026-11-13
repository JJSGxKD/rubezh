import { useState } from "react";
import { api } from "../../services";
import { DIFFICULTIES, divisionTitle, fetchSeason, PAGE_SIZE, rewardText, scoreText, weekTitle, type RatingBoard, type RatingDifficulty, type SeasonView as SeasonData } from "../../api/rating";
import { formatDateTime, formatNumber } from "../../format";
import { can } from "../../state/session";
import { useSession } from "../../state/use-session";
import { HELP } from "../../ui/help";
import { Button, DataTable, ErrorNotice, KeyValue, Loading, Panel } from "../../ui/kit";
import { navigate } from "../../ui/router";
import { useApi } from "../../ui/use-api";
import { BoardSelect, DifficultySelect, PlayerLink } from "./controls";

/** Сложность из адреса; нет или чужая — «Сложная»: на ней играют (Р126). */
function difficultyOf(tab: string | undefined): RatingDifficulty {
  return DIFFICULTIES.find((id) => id === tab) ?? "hard";
}

/**
 * Итоги одного закрытого сезона на выбранной сложности: места, дивизионы и
 * награды, записанные при закрытии. Сложность — в адресе третьей частью, чтобы
 * ссылкой на неделю из карточки игрока можно было поделиться.
 */
export function SeasonView({ seasonKey, tab }: { seasonKey: string; tab: string | undefined }) {
  const view = useSession((session) => session.view);
  const canFull = can(view, "players.board.restrict");
  const difficulty = difficultyOf(tab);
  const [picked, setPicked] = useState<RatingBoard>("common");
  const board = canFull ? picked : "common";
  const [more, setMore] = useState<{ key: string; rows: SeasonData["rows"] }>({ key: "", rows: [] });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const { state, reload } = useApi(() => fetchSeason(api, seasonKey, { difficulty, board, offset: 0, limit: PAGE_SIZE }), [seasonKey, difficulty, board]);

  const pageKey = `${seasonKey}|${difficulty}|${board}`;
  const data = state.status === "ok" ? state.data : null;
  const extra = more.key === pageKey ? more.rows : [];
  const rows = data === null ? [] : [...data.rows, ...extra];

  const showMore = async () => {
    setLoadingMore(true);
    setMoreError(null);
    const result = await fetchSeason(api, seasonKey, { difficulty, board, offset: rows.length, limit: PAGE_SIZE });
    setLoadingMore(false);
    if (!result.ok) return setMoreError(result.error.message);
    setMore({ key: pageKey, rows: [...extra, ...result.data.rows] });
  };

  const open = (next: RatingDifficulty) => navigate({ section: "rating", id: seasonKey, tab: next });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button onClick={() => navigate({ section: "rating", id: null })}>← Рейтинг</Button>
      </div>
      <Panel title={`Сезон · ${weekTitle(seasonKey)}`} help={HELP.rating.section}>
        {state.status === "loading" ? <Loading /> : null}
        {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
        {data === null ? null : (
          <div className="flex flex-col gap-3">
            <KeyValue
              items={[
                ["Неделя", weekTitle(data.season.key)],
                ["Игроков", formatNumber(data.season.players)],
                ["С наградой", formatNumber(data.season.rewarded)],
                ["Считали по", data.season.scoring === "time" ? "времени" : "очкам"],
                ["Закрыт", formatDateTime(data.season.closedAt)],
              ]}
            />
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <DifficultySelect value={difficulty} onChange={open} />
              {canFull ? <BoardSelect value={picked} onChange={setPicked} /> : null}
            </div>
            <DataTable
              rows={rows}
              rowKey={(row) => `${String(row.place)}-${row.accountId}`}
              empty="На этой доске пока никого"
              columns={[
                { title: "Место", render: (row) => row.place, align: "right" },
                { title: "Игрок", render: (row) => <PlayerLink accountId={row.accountId} name={row.name} />, primary: true },
                { title: "Результат", render: (row) => scoreText(row.best, data.season.scoring), align: "right" },
                { title: "Из", render: (row) => formatNumber(row.boardSize), align: "right" },
                { title: "Дивизион", help: HELP.rating.division, render: (row) => divisionTitle(row.division) },
                { title: "Награда", render: (row) => (row.reward === null ? "—" : rewardText(row.reward)) },
                { title: "Получена", render: (row) => (row.reward === null ? "—" : row.reward.status === "claimed" ? formatDateTime(row.reward.claimedAt) : "ждёт") },
              ]}
            />
            <p className="text-xs text-text-muted">
              Показано {formatNumber(rows.length)} из {formatNumber(data.total)}
            </p>
            {moreError === null ? null : <p className="text-sm text-danger">{moreError}</p>}
            {rows.length < data.total ? (
              <div>
                <Button disabled={loadingMore} onClick={() => void showMore()}>
                  {loadingMore ? "Загружаем…" : "Показать ещё"}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </Panel>
    </div>
  );
}
