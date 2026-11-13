import { useSyncExternalStore, type ReactNode } from "react";
import { Users } from "lucide-react";
import type { ButtonBar } from "@bh/shared-types";
import { formatNumber, t } from "../i18n";
import { formatOnlineCount, onlinePlacement, onlineView, useOnline, type OnlinePlacement, type OnlineView } from "../state/online";
import { useShell } from "../state/shell";
import { useWide } from "../state/wide";

/**
 * Плашка онлайна (Р107, tasks/T-0148, макет `design/art/mockups/planned-meta-2.html`):
 * «● 128 онлайн» — сколько людей сейчас в игре. Это сведения, а не кнопка:
 * нажатий нет, жесты проходят насквозь, выключателя в настройках нет.
 *
 * Стоит в одном из трёх мест (`onlinePlacement`):
 * - в полосе кнопок площадки, по центру между «Закрыть» и меню — Telegram во
 *   весь экран, где это место иначе пустует;
 * - строкой под шапкой — везде, где полосы нет; шапку она не раздвигает, место
 *   под ней оставляет оболочка (`data-online-line` на корне, tokens.css);
 * - в широкой шапке по центру — на ПК.
 *
 * «Онлайн неизвестен» — «сегодня играли N» без точки: точка значит «сейчас».
 * Чисел нет вовсе — плашки нет, без заглушки «—».
 */

/**
 * Полоса кнопок площадки: подписка на адаптер напрямую, без зеркала в сторе
 * площадки. Нет свойства у адаптера (VK, MAX, браузер) — полосы нет.
 */
export function useButtonBar(): ButtonBar | null {
  const ui = useShell((state) => state.adapter.ui);
  return useSyncExternalStore(
    (notify) => ui.onButtonBarChange?.(() => notify()) ?? (() => undefined),
    () => ui.buttonBar ?? null,
    () => null,
  );
}

/** Где сейчас стоит плашка; `null` — плашки нет (нет чисел). */
export function useOnlinePlacement(): OnlinePlacement | null {
  const wide = useWide((state) => state.wide);
  const bar = useButtonBar();
  const shown = useOnline((state) => onlineView(state) !== null);
  return shown ? onlinePlacement({ wide, bar }) : null;
}

/** Плашка под шапкой занимает место в потоке экрана: оболочка отодвигает от неё содержимое. */
export function useOnlineSubline(): boolean {
  return useOnlinePlacement() === "subline";
}

/** Плашка со своим стором: для широкой шапки, где место задаёт сама шапка. */
export function OnlinePill(props: { variant: OnlinePlacement }): ReactNode {
  const online = useOnline((state) => state.online);
  const todayPlayed = useOnline((state) => state.todayPlayed);
  return <OnlinePillView view={onlineView({ online, inRun: null, todayPlayed })} variant={props.variant} />;
}

/**
 * Плашка в шапке телефона: в полосе кнопок или строкой под шапкой. Кладётся
 * внутрь шапки, которая сама `absolute`, поэтому обе раскладки от неё и
 * отсчитываются, а высота шапки не меняется.
 */
export function OnlineHeaderSlot(): ReactNode {
  const placement = useOnlinePlacement();
  const bar = useButtonBar();
  if (placement === "bar" && bar !== null) {
    return (
      <div className="pointer-events-none absolute inset-x-0 flex items-center justify-center" style={{ top: bar.top, height: bar.height }}>
        <OnlinePill variant="bar" />
      </div>
    );
  }
  if (placement === "subline") {
    return (
      <div className="pointer-events-none absolute inset-x-0 top-full flex justify-center pt-1">
        <OnlinePill variant="subline" />
      </div>
    );
  }
  return null;
}

/** Чистая плашка: вид и место приходят снаружи, чтобы её можно было проверить без стора. */
export function OnlinePillView(props: { view: OnlineView | null; variant: OnlinePlacement }): ReactNode {
  const { view, variant } = props;
  if (view === null) return null;
  const value = formatOnlineCount(view.count);
  const now = view.kind === "now";
  const label = now ? t("online.now.label", { count: formatNumber(view.count) }) : t("online.today.label", { value });
  // В полосе кнопок на узких экранах (320–359 px) места мало: число без слова,
  // полное — в подписи для чтения с экрана.
  const compact = variant === "bar";
  const word = t(now ? "online.now.word" : "online.today.word");

  return (
    <span
      role="img"
      aria-label={label}
      className="surface-sunken inline-flex h-[26px] items-center gap-1.5 rounded-pill px-2.5 font-text text-xs font-semibold whitespace-nowrap text-text tabular-nums"
    >
      {now ? (
        <span data-online-dot="" aria-hidden="true" className="relative inline-flex size-2 shrink-0 rounded-full bg-success">
          <span className="absolute inset-0 animate-online-pulse rounded-full bg-success opacity-0" />
        </span>
      ) : (
        <Users aria-hidden="true" size={14} className="shrink-0 text-text-muted" />
      )}
      {compact ? (
        <span aria-hidden="true">
          {now ? (
            <>
              {value}
              <span className="hidden min-[360px]:inline"> {word}</span>
            </>
          ) : (
            <>
              <span className="hidden min-[360px]:inline">{word} </span>
              {value}
            </>
          )}
        </span>
      ) : (
        <span aria-hidden="true">{now ? `${value} ${word}` : `${word} ${value}`}</span>
      )}
    </span>
  );
}
