import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { LeaderboardEntry } from "@bh/shared-types";
import { Button, InfoNotice, staggerStyle } from "../../design-system/components";
import { formatDuration, t } from "../../i18n";
import "../../i18n/season";
import { useRestricted } from "../../state/restrictions";
import { useRuns } from "../../state/runs";
import { createSeasonsApi, type BoardScope, type SeasonBoard, type SeasonData, type SeasonsOverview } from "../../state/seasons-api";
import { RestrictedPlaque } from "./restricted-plaque";
import { RewardsCard, HistoryList } from "./rating-rewards";
import { formatSeasonLeft, seasonDateLabel, seasonLeftAt, seasonRangeLabel } from "./rating-rules";

/**
 * Вкладки «Неделя» и «Друзья» рейтинга (tasks/T-0111, docs/39-retention-mechanics.md
 * Р1): заголовок сезона с таймером, твоё лучшее, таблица недели, награды и
 * прошлые сезоны. Рейтинговая сложность одна — `hard` (Р126), переключателя нет.
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

type BoardState = { status: "loading" } | { status: "failed" } | { status: "ready"; board: SeasonBoard };

/** Один запрос на пару (сложность, вкладка): ответ на уже сменённую вкладку состояние не затирает. */
function useSeasonBoard(scope: BoardScope, enabled: boolean): { state: BoardState; retry(): void } {
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

export function SeasonTab(props: {
  scope: BoardScope;
  data: SeasonData;
  receivedAt: number;
  reload(): Promise<void>;
  restriction: readonly string[];
  /** строка таблицы — та же, что у «Всё время» */
  row(entry: LeaderboardEntry, index: number): ReactNode;
  onInvite(): void;
}): ReactNode {
  const { data, scope } = props;
  const season = data.season;
  // Конец сезона по монотонным часам: стабилен между тиками, меняется только с новым ответом.
  const expiresAt = season === null ? null : props.receivedAt + season.secondsLeft * 1000;
  const now = useClock(expiresAt);
  const left = season === null ? null : seasonLeftAt(season.secondsLeft, props.receivedAt, now);
  const { state, retry } = useSeasonBoard(scope, season !== null);
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
  const noFriends = scope === "friends" && board !== null && board.entries.every((entry) => entry.isMe);

  return (
    <div className="grid grid-cols-1 gap-3" aria-busy={state.status === "loading"}>
      <div className="surface-card rounded-lg p-3">
        <p className="font-display text-sm font-bold text-text">{t("season.title", { range: seasonRangeLabel(season.startsAt, season.endsAt) })}</p>
        <p className="mt-0.5 text-sm text-text">{expired ? formatSeasonLeft(0) : t("season.left", { time: formatSeasonLeft(left ?? 0) })}</p>
        <p className="mt-1 text-xs text-text-muted">{t("season.utcNote")}</p>
      </div>

      <RestrictedPlaque kinds={props.restriction} />
      {restricted ? null : (
        <p className="text-sm text-text-muted">
          {mine === null ? t("season.mine.none") : t("season.mine", { time: formatDuration(mine) })}
        </p>
      )}

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
      ) : board.entries.length === 0 ? (
        <p className="surface-sunken rounded-lg p-4 text-center text-sm text-text-muted">{t("rating.empty")}</p>
      ) : (
        <ol className="grid grid-cols-1 gap-2">{board.entries.map((entry, index) => props.row(entry, index))}</ol>
      )}

      {scope === "all" ? (
        <>
          <RewardsCard data={data} best={mine} total={board?.total ?? null} />
          <HistoryList history={data.history} />
        </>
      ) : null}
    </div>
  );
}
