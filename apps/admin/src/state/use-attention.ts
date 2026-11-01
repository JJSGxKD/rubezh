import { useEffect, useState } from "react";
import { attentionTotal, fetchAttention } from "../api/attention";
import { api } from "../services";

/**
 * Число «Ждёт вас» для меню (tasks/T-0359): сразу при входе, раз в минуту,
 * пока вкладка видна, и при возврате в неё. Не ответил сервер — число прежнее:
 * это подсказка, а не экран, ошибку не показываем.
 */
export const ATTENTION_REFRESH_MS = 60_000;

/** Текст знака: ноль — знака нет, больше 99 — «99+». */
export function badgeText(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? "99+" : String(count);
}

export function useAttention(enabled: boolean): number {
  const [total, setTotal] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      void fetchAttention(api).then((result) => {
        if (alive && result.ok) setTotal(attentionTotal(result.data.items));
      });
    };
    refresh();
    const timer = setInterval(refresh, ATTENTION_REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [enabled]);

  return enabled ? total : 0;
}
