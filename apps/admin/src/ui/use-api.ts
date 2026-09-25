import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError, ApiResult } from "../api/client";

export type Loaded<T> = { status: "loading" } | { status: "ok"; data: T } | { status: "error"; error: ApiError };

/**
 * Загрузка данных раздела. Ответ устаревшего запроса отбрасывается: игрок,
 * открытый позже, не должен смениться карточкой того, что открыли раньше и
 * что ответило медленнее.
 *
 * Повторная загрузка того же объекта (`reload` после действия) держит
 * прежние данные на экране: иначе панель действия размонтируется вместе с
 * сообщением «проведено», и человек не узнает, чем кончилось нажатие.
 */
export function useApi<T>(load: () => Promise<ApiResult<T>>, deps: readonly unknown[]): { state: Loaded<T>; reload: () => void } {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(0);
  const shownDeps = useRef<readonly unknown[] | null>(null);

  useEffect(() => {
    const ticket = ++latest.current;
    const previous = shownDeps.current;
    const sameObject = previous !== null && previous.length === deps.length && previous.every((value, index) => Object.is(value, deps[index]));
    shownDeps.current = deps;
    if (!sameObject) setState({ status: "loading" });
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
