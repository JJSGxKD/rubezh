import { api } from "../../services";
import { DIFFICULTIES, divisionTitle, fetchPlayerSeasons, rewardText, scoreText, weekTitle, type PlayerSeason, type RatingDifficulty } from "../../api/rating";
import { difficultyTitle } from "../../api/review";
import { formatNumber } from "../../format";
import { hrefOf } from "../../routes";
import { can } from "../../state/session";
import { useSession } from "../../state/use-session";
import { HELP } from "../../ui/help";
import { DataTable, ErrorNotice, Loading, Panel } from "../../ui/kit";
import { useApi } from "../../ui/use-api";

const BOARD_LABEL = { common: "общая", full: "полная" } as const;

/**
 * «Места по неделям» в карточке игрока (tasks/T-0381): итоги закрытых недельных
 * сезонов по сложностям. Неделя — ссылка в итоги сезона на этой сложности.
 * Колонка «Доска» — только при праве `players.board.restrict`: сервер без него
 * строк отдельной доски не отдаёт, а лишней колонки не должно быть вовсе.
 */
export function SeasonPlacesPanel({ accountId }: { accountId: string }) {
  const { state, reload } = useApi(() => fetchPlayerSeasons(api, accountId), [accountId]);
  const view = useSession((session) => session.view);
  const canFull = can(view, "players.board.restrict");
  const seasons = state.status === "ok" ? state.data.seasons : null;

  return (
    <Panel title="Места по неделям" help={HELP.players.seasonPlaces}>
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {seasons === null ? null : (
        <DataTable
          rows={seasons}
          rowKey={(season) => season.key}
          empty="Игрок не попадал в итоги недельных сезонов"
          columns={[
            { title: "Неделя", render: (season) => <WeekLink season={season} />, primary: true },
            ...DIFFICULTIES.map((id) => ({ title: capitalize(difficultyTitle(id)), render: (season: PlayerSeason) => <PlaceCell season={season} difficulty={id} /> })),
            { title: "Награда", render: (season: PlayerSeason) => (season.reward === null ? "—" : rewardText(season.reward)) },
            ...(canFull
              ? [{ title: "Доска", render: (season: PlayerSeason) => boardsOf(season) }]
              : []),
          ]}
        />
      )}
    </Panel>
  );
}

/** Неделя — в итоги на сложности, где у игрока есть место, иначе на «Сложной». */
function WeekLink({ season }: { season: PlayerSeason }) {
  const difficulty = season.results[0]?.difficulty ?? "hard";
  return (
    <a className="whitespace-nowrap text-accent hover:underline" href={hrefOf({ section: "rating", id: season.key, tab: difficulty })}>
      {weekTitle(season.key)}
    </a>
  );
}

function PlaceCell({ season, difficulty }: { season: PlayerSeason; difficulty: RatingDifficulty }) {
  const result = season.results.find((item) => item.difficulty === difficulty);
  if (result === undefined) return <span className="text-text-muted">—</span>;
  return (
    <span className="whitespace-nowrap" title={scoreText(result.best, season.scoring)}>
      {formatNumber(result.place)} из {formatNumber(result.boardSize)} · {divisionTitle(result.division)}
    </span>
  );
}

function boardsOf(season: PlayerSeason): string {
  const boards = [...new Set(season.results.map((item) => item.board).filter((board) => board !== undefined))];
  return boards.length === 0 ? "—" : boards.map((board) => BOARD_LABEL[board]).join(", ");
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
