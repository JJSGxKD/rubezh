import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError, ApiResult } from "../api/client";

export type Loaded<T> = { status: "loading" } | { status: "ok"; data: T } | { status: "error"; error: ApiError };

/**
 * Загрузка данных раздела. Ответ устаревшего запроса отбрасывается: игрок,
 * открытый позже, не должен смениться карточкой того, что открыли раньше и
 * что ответило медленнее.
 */
export function useApi<T>(load: () => Promise<ApiResult<T>>, deps: readonly unknown[]): { state: Loaded<T>; reload: () => void } {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    const ticket = ++latest.current;
    setState({ status: "loading" });
    void load().then((result) => {
      if (ticket !== latest.current) return;
      setState(result.ok ? { status: "ok", data: result.data } : { status: "error", error: result.error });
    });
    // Зависимости задаёт вызывающий: функция загрузки новая на каждой
    // отрисовке, и по ней эффект перезапускался бы бесконечно.
  }, [...deps, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { state, reload };
}
