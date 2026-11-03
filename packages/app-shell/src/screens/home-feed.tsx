import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { t } from "../i18n";
import "../i18n/home";
import { feedDue, claimFeedView, feedTextOf, freshItems, nextHoldMs, nextIndex } from "./home-feed-rules";
import { refreshFeed, useFeed } from "../state/feed-api";
import { track } from "../state/shell";

/**
 * Лента живых событий под «Играть» (Р114, tasks/T-0176): одна строка «кто-то
 * только что…», которая сменяется сама раз в 5–8 секунд. Что показывать,
 * решает сервер (`GET /api/v1/feed`); компонент только листает, не придумывая
 * ничего своего. Событий нет — строки нет, ни отступа, ни заглушки.
 *
 * Спокойная: на экране одна строка, не мигает, не кнопка и не ссылка. Из
 * движения — только прозрачность новой строки; при «меньше движения» текст
 * заменяется сразу. Скрытая вкладка таймеров не держит. Отдельного
 * выключателя в настройках нет (docs/27-design-system-and-app-shell.md §7.1).
 *
 * Едет с чанком главной (`home-live.ts`): первой загрузке лента не нужна.
 */

/** Сколько событие должно быть на виду, чтобы засчитать показ. */
const VIEWED_MS = 1_000;
/** Низкий ландшафт телефона: там ленты нет (`home.tsx`) — показов она не считает. */
const LOW_SCREEN = "(max-height: 480px)";

/** Показанные за запуск приложения события: память модуля, не хранилище (новый запуск — с нуля). */
const viewedThisLaunch = new Set<string>();

function mediaMatches(query: string): boolean {
  return typeof matchMedia === "function" && matchMedia(query).matches;
}

/** Вкладка видна: свёрнутое приложение ленту не листает и не опрашивает. */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const update = (): void => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

export function HomeFeed(): ReactNode {
  const stored = useFeed((state) => state.items);
  const refreshSec = useFeed((state) => state.refreshSec);
  const visible = usePageVisible();
  // `now` обновляется на каждой смене события: устройство с долго открытой главной не покажет вчерашнее.
  const [view, setView] = useState(() => ({ id: null as string | null, now: Date.now() }));
  const list = useMemo(() => freshItems(stored, view.now), [stored, view.now]);
  const index = Math.max(0, list.findIndex((item) => item.id === view.id));
  const current = list[index];
  const shownId = useRef<string | null>(null);

  useEffect(() => {
    shownId.current = current?.id ?? null;
  }, [current?.id]);

  // Опрос: сразу, если пора, и затем раз в `refreshSec`, пока вкладка видна.
  useEffect(() => {
    if (!visible) return;
    const { askedAt } = useFeed.getState();
    if (feedDue(askedAt, refreshSec, Date.now())) void refreshFeed();
    const timer = setInterval(() => void refreshFeed(), refreshSec * 1000);
    return () => clearInterval(timer);
  }, [visible, refreshSec]);

  // Смена события: следующее по кругу; единственное остаётся, но срок свежести проверяется.
  const hasItems = list.length > 0;
  useEffect(() => {
    if (!visible || !hasItems) return;
    const timer = setTimeout(() => {
      const now = Date.now();
      const fresh = freshItems(useFeed.getState().items, now);
      const next = nextIndex(fresh, shownId.current);
      setView({ id: next === -1 ? null : (fresh[next]?.id ?? null), now });
    }, nextHoldMs(Math.random));
    return () => clearTimeout(timer);
  }, [visible, hasItems, view]);

  // Показ — раз на событие за запуск и только если оно пробыло на виду секунду.
  useEffect(() => {
    if (!visible || current === undefined) return;
    const { id, kind } = current;
    const timer = setTimeout(() => {
      if (document.visibilityState !== "visible" || mediaMatches(LOW_SCREEN)) return;
      if (claimFeedView(viewedThisLaunch, id)) track("feed_event_viewed", { kind, position: index });
    }, VIEWED_MS);
    return () => clearTimeout(timer);
  }, [visible, current?.id]);

  if (current === undefined) return null;
  const { key, params } = feedTextOf(current);

  return (
    <section aria-label={t("feed.label")} aria-live="off" className="mt-2 min-w-0 text-center">
      {/* Ключ — событие: строка появляется заново и проявляется по прозрачности; единственная анимация ленты. */}
      <p key={current.id} className="animate-fade-in truncate text-xs text-text-muted motion-reduce:animate-none">
        {t(key, params)}
      </p>
    </section>
  );
}
