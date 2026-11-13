import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError } from "../../../api/client";
import {
  fetchCheck,
  startCheck,
  type CheckStatus,
  type CheckView,
} from "../../../api/content";
import { api } from "../../../services";
import {
  CHECK_POLL_LIMIT_MS,
  CHECK_POLL_MS,
  isStale,
  parseCheckOutcome,
  railSteps,
  type CheckOutcome,
  type Rails,
} from "./check-rules";

/** Прошлая проверка черновика, как её отдал сервер вместе с черновиком. */
export interface LastCheck {
  checkId: string;
  status: string;
}

export interface CheckState {
  /** проверка идёт: опрос статуса */
  running: boolean;
  status: CheckStatus | null;
  outcome: CheckOutcome | null;
  /** хэш снимка, который проверяли */
  checkedHash: string | null;
  /** опрос не дождался за три минуты или запрос не удался */
  problem: string | null;
  error: ApiError | null;
  stale: boolean;
  rails: Rails;
  start: () => void;
}

const TIMEOUT_TEXT =
  "Проверка не закончилась за три минуты. Попробуйте ещё раз — если сервер занят, она ждёт в очереди.";

/**
 * Проверка черновика: «Проверить» ставит задание и опрашивает статус раз в 2 с,
 * не дольше трёх минут. Прошлая проверка черновика подтягивается при открытии,
 * а ждущая — продолжает опрашиваться. Закрытие экрана опрос останавливает.
 */
export function useCheck(
  draftId: string | null,
  currentHash: string,
  last: LastCheck | null,
): CheckState {
  const [view, setView] = useState<CheckView | null>(null);
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const alive = useRef(true);
  const generation = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const poll = useCallback(async (checkId: string): Promise<void> => {
    const mine = ++generation.current;
    const deadline = Date.now() + CHECK_POLL_LIMIT_MS;
    setRunning(true);
    setProblem(null);
    for (;;) {
      const result = await fetchCheck(api, checkId);
      if (!alive.current || mine !== generation.current) return;
      if (!result.ok) {
        setError(result.error);
        setRunning(false);
        return;
      }
      setView(result.data);
      if (result.data.status !== "queued") {
        setRunning(false);
        if (result.data.status === "failed")
          setProblem("Проверка не посчиталась. Повторите её.");
        return;
      }
      if (Date.now() >= deadline) {
        setRunning(false);
        setProblem(TIMEOUT_TEXT);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, CHECK_POLL_MS));
      if (!alive.current || mine !== generation.current) return;
    }
  }, []);

  // Прошлая проверка при открытии черновика: готовая — показать, ждущая — досчитать.
  const lastId = last?.checkId ?? null;
  useEffect(() => {
    if (lastId !== null) void poll(lastId);
  }, [lastId, poll]);

  const start = useCallback((): void => {
    if (draftId === null) return;
    setError(null);
    setProblem(null);
    setRunning(true);
    void startCheck(api, draftId).then((result) => {
      if (!alive.current) return;
      if (!result.ok) {
        setError(result.error);
        setRunning(false);
        return;
      }
      setView(result.data.check);
      if (result.data.check.status === "queued")
        void poll(result.data.check.checkId);
      else setRunning(false);
    });
  }, [draftId, poll]);

  const outcome = view === null ? null : parseCheckOutcome(view.report);
  const checkedHash = view?.snapshotHash ?? null;
  const stale = isStale(checkedHash, currentHash);
  const status = view?.status ?? null;
  return {
    running,
    status,
    outcome,
    checkedHash,
    problem,
    error,
    stale,
    rails: railSteps({ outcome, status, stale, running }),
    start,
  };
}
