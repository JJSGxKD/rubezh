import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { LeaderboardEntry } from "@bh/shared-types";
import { Button, InfoNotice, SegmentedControl, staggerStyle } from "../../design-system/components";
import { formatDuration, t } from "../../i18n";
import "../../i18n/season";
import { useRestricted } from "../../state/restrictions";
import { useRuns } from "../../state/runs";
import {
  createSeasonsApi,
  scoringOf,
  type BoardScope,
  type SeasonBoard,
  type SeasonData,
  type SeasonsOverview,
} from "../../state/seasons-api";
import { track } from "../../state/shell";
import { RestrictedPlaque } from "./restricted-plaque";
import { RewardsCard, HistoryList } from "./rating-rewards";
import {
  RATING_CIRCLES,
  divisionId,
  divisionPlace,
  formatSeasonLeft,
  nextDivisionGap,
  seasonDateLabel,
  seasonDaysLeft,
  seasonLeftAt,
  seasonRangeLabel,
  type DivisionId,
  type RatingCircle,
  type Scoring,
} from "./rating-rules";
import { DivisionPlaque, StyleBlock } from "./rating-style";

/**
 * Период «Неделя» рейтинга (tasks/T-0111, docs/39-retention-mechanics.md Р1;
 * круги «Все», «Друзья» и «Мой дивизион» — tasks/T-0296): подпись сезона,
 * плашка дивизиона, таблица недели, награды, «Твой стиль» и прошлые сезоны.
 * Рейтинговая сложность одна — `hard` (Р126), переключателя нет.
 */
export const SEASON_DIFFICULTY = "hard";

const api = createSeasonsApi();

/** Таймер обновляется раз в минуту: секунды в сезоне длиной в неделю никому не нужны. */
const CLOCK_PERIOD_MS = 60_000;
/** Время вышло, а сезон не закрыт: спросить сервер ещё раз через столько. */
const CLOSING_RETRY_MS = 30_000;

export interface SeasonState {
  /** `null` — первый ответ ещё не пришёл */
  overview: SeasonsOverview | null;
  /** `performance.now()` на момент ответа — точка отсчёта таймера */
  receivedAt: number;
  reload(): Promise<void>;
}

/**
 * Обзор сезона. Не ответил сервер (нет сети, старая версия, выключено) — экран
 * остаётся прежним: вкладок нет. Перечитывание, не удавшееся позже, оставляет
 * прежний ответ: вкладки не должны пропадать из-за одного сбоя.
 */
export function useSeasonOverview(): SeasonState {
  const [state, setState] = useState<{ overview: SeasonsOverview | null; receivedAt: number }>({ overview: null, receivedAt: 0 });

  const reload = useCallback(async (): Promise<void> => {
    const response = await api.overview();
    const receivedAt = performance.now();
    setState((prev) => {
      if (response.ok) return { overview: response.data, receivedAt };
      return prev.overview === null ? { overview: { enabled: false }, receivedAt } : prev;
    });
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { overview: state.overview, receivedAt: state.receivedAt, reload };
}

/** Монотонное «сейчас»: тикает раз в минуту, в фоне вкладки молчит, к концу сезона (`expiresAt` по `performance.now()`) — ровно в срок. */
function useClock(expiresAt: number | null): number {
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    const tick = (): void => setNow(performance.now());
    const visible = (): boolean => document.visibilityState === "visible";
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = (): void => {
      if (timer === null) timer = setInterval(tick, CLOCK_PERIOD_MS);
    };
    const stop = (): void => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = (): void => {
      if (visible()) {
        tick();
        start();
      } else stop();
    };
    if (visible()) start();
    document.addEventListener("visibilitychange", onVisibility);
    const delay = expiresAt === null ? 0 : expiresAt - performance.now();
    const expiry = delay > 0 ? setTimeout(tick, delay + 50) : null;
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      if (expiry !== null) clearTimeout(expiry);
    };
  }, [expiresAt]);

  return now;
}

export function BoardSkeleton(): ReactNode {
  return (
    <div className="grid gap-2" aria-hidden="true">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="surface-card h-14 animate-pulse rounded-lg" style={staggerStyle(index)} />
      ))}
    </div>
  );
}

export type BoardState = { status: "loading" } | { status: "failed" } | { status: "ready"; board: SeasonBoard };

/** Один запрос на пару (сложность, вкладка): ответ на уже сменённую вкладку состояние не затирает. */
export function useSeasonBoard(scope: BoardScope, enabled: boolean): { state: BoardState; retry(): void } {
  const [state, setState] = useState<BoardState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    setState({ status: "loading" });
    void (async () => {
      // Неотправленные забеги уходят сперва: иначе игрок не нашёл бы в таблице только что сыгранный.
      await useRuns.getState().flush("screen");
      const response = await api.board(SEASON_DIFFICULTY, scope);
      if (current) setState(response.ok ? { status: "ready", board: response.data } : { status: "failed" });
    })();
    return () => {
      current = false;
    };
  }, [scope, enabled, attempt]);

  return { state, retry: () => setAttempt((value) => value + 1) };
}

export interface WeekBoard {
  state: BoardState;
  retry(): void;
}

/** Что показывает таблица: строки, по чему они ранжированы, нужен ли пьедестал и откуда брать место. */
export interface BoardListView {
  entries: readonly LeaderboardEntry[];
  scoring: Scoring;
  podium: boolean;
  /** место строки на экране; не задано — место на доске */
  placeOf?: ((entry: LeaderboardEntry) => number) | undefined;
}

/** По чему ранжирована таблица недели: ответ таблицы, иначе обзор, иначе время. */
export function weekScoring(board: SeasonBoard | null, data: SeasonData): Scoring {
  return board?.scoring !== undefined ? scoringOf(board.scoring) : data.scoring;
}

export function SeasonTab(props: {
  circle: RatingCircle;
  onCircle(circle: RatingCircle): void;
  data: SeasonData;
  receivedAt: number;
  reload(): Promise<void>;
  restriction: readonly string[];
  board: WeekBoard;
  /** таблица — та же, что у «Всё время»: пьедестал и строки */
  list(view: BoardListView): ReactNode;
  onInvite(): void;
}): ReactNode {
  const { data, circle } = props;
  const season = data.season;
  // Конец сезона по монотонным часам: стабилен между тиками, меняется только с новым ответом.
  const expiresAt = season === null ? null : props.receivedAt + season.secondsLeft * 1000;
  const now = useClock(expiresAt);
  const left = season === null ? null : seasonLeftAt(season.secondsLeft, props.receivedAt, now);
  const { state, retry } = props.board;
  const restricted = useRestricted(props.restriction);
  const expired = left !== null && left <= 0;
  const reload = props.reload;

  useEffect(() => {
    if (!expired) return;
    const timer = setTimeout(() => void reload(), CLOSING_RETRY_MS);
    return () => clearTimeout(timer);
  }, [expired, data, reload]);

  if (season === null) {
    const date = data.startsAt === null ? "" : seasonDateLabel(data.startsAt);
    return date === "" ? null : <InfoNotice text={t("season.notStarted", { date })} />;
  }

  const mine = data.mine[SEASON_DIFFICULTY] ?? null;
  const board = state.status === "ready" ? state.board : null;
  const scoring = weekScoring(board, data);
  const myDivision = divisionId(board?.me?.division ?? data.division[SEASON_DIFFICULTY]);
  const noFriends = circle === "friends" && board !== null && board.entries.every((entry) => entry.isMe);
  const bestPoints = data.minePoints[SEASON_DIFFICULTY] ?? board?.me?.points ?? null;
  const best = scoring === "points" ? (bestPoints === null ? null : { kind: "points" as const, value: bestPoints }) : mine === null ? null : { kind: "time" as const, value: mine };
  // Граница дивизиона видна только на общей доске: у друзей «место» и «размер доски» другие.
  const next = board === null || board.me === null || myDivision === null || circle === "friends" ? null : nextDivisionGap(myDivision, board.total, board.me, board.entries, scoring);

  return (
    <div className="grid grid-cols-1 gap-3" aria-busy={state.status === "loading"}>
      <div>
        <p className="font-display text-sm font-bold text-text">
          {expired ? formatSeasonLeft(0) : t("rating.season.line", { range: seasonRangeLabel(season.startsAt, season.endsAt), days: seasonDaysLeft(left ?? 0) })}
        </p>
        <p className="mt-0.5 text-xs text-text-muted">{t("season.utcNote")}</p>
      </div>

      <RestrictedPlaque kinds={props.restriction} />
      {restricted ? null : myDivision !== null ? (
        <DivisionPlaque division={myDivision} best={best} next={next} />
      ) : (
        <p className="text-sm text-text-muted">{mine === null ? t("season.mine.none") : scoring === "time" ? t("season.mine", { time: formatDuration(mine) }) : t("rating.plaque.none")}</p>
      )}

      <SegmentedControl
        track="rating_circle"
        label={t("rating.circles")}
        items={RATING_CIRCLES.map((id) => ({ id, label: t(`rating.circle.${id}`) }))}
        activeId={circle}
        onSelect={(id) => {
          const next = RATING_CIRCLES.find((circleId) => circleId === id);
          if (next === undefined || next === circle) return;
          track("rating_circle_changed", { circle: next });
          props.onCircle(next);
        }}
      />

      {state.status === "loading" ? <BoardSkeleton /> : null}
      {state.status === "failed" ? (
        <div role="status" className="surface-sunken rounded-lg p-4">
          <p className="text-sm text-text-muted">{t("season.error")}</p>
          <div className="mt-2">
            <Button track="retry" variant="secondary" onClick={retry}>
              {t("season.retry")}
            </Button>
          </div>
        </div>
      ) : null}
      {board === null ? null : noFriends ? (
        <div className="surface-sunken grid justify-items-center gap-3 rounded-lg p-4 text-center">
          <p className="text-sm text-text-muted">{t("season.friends.empty")}</p>
          <Button track="invite_friends" onClick={props.onInvite}>
            {t("season.friends.invite")}
          </Button>
        </div>
      ) : circle === "division" ? (
        <DivisionList division={myDivision} board={board} scoring={scoring} list={props.list} />
      ) : board.entries.length === 0 ? (
        <p className="surface-sunken rounded-lg p-4 text-center text-sm text-text-muted">{t("rating.empty")}</p>
      ) : (
        props.list({ entries: board.entries, scoring, podium: true })
      )}

      {circle === "all" ? (
        <>
          {/* В сезоне по очкам порог по времени не награда: полоса порога спрятана, пока клиент не знает порога в очках. */}
          <RewardsCard data={scoring === "points" ? { ...data, thresholds: {} } : data} best={mine} total={board?.total ?? null} />
          <StyleBlock />
          <HistoryList history={data.history} />
        </>
      ) : null}
    </div>
  );
}

/**
 * Список «Мой дивизион»: игроки моего дивизиона из показанных строк, место —
 * внутри дивизиона и считается от его начала, а не по показанным строкам. Сервер
 * отдаёт верх таблицы, поэтому нижние дивизионы видны не целиком.
 */
function DivisionList(props: { division: DivisionId | null; board: SeasonBoard; scoring: Scoring; list(view: BoardListView): ReactNode }): ReactNode {
  const { division, board } = props;
  if (division === null) return <p className="surface-sunken rounded-lg p-4 text-center text-sm text-text-muted">{t("rating.division.none")}</p>;
  const members = board.entries.filter((entry) => entry.division === division);
  if (members.length === 0) return <p className="surface-sunken rounded-lg p-4 text-center text-sm text-text-muted">{t("rating.division.empty")}</p>;
  return props.list({ entries: members, scoring: props.scoring, podium: false, placeOf: (entry) => divisionPlace(entry.rank, division, board.total) });
}
