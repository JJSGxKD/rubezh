import type { ReactNode } from "react";
import { t } from "../i18n";
import type { WidgetId, WidgetSize } from "./home-widget-rules";
import { DailyView, Frame, FriendsView, RecordView, TasksView, WheelView } from "./home-widgets";

/**
 * Все состояния каждого виджета на тестовых данных — для витрины
 * компонентов (docs/27-design-system-and-app-shell.md §9): чтобы увидеть
 * «джекпот» или «рекорд — в последнем забеге», не нужно их дожидаться.
 */
export function WidgetShowcase(props: { now: number }): ReactNode {
  const { now } = props;
  const days = [60, 80, 100, 120, 150, 180, 300].map((coins, index) => ({ coins, shards: index === 6 ? 10 : 0, claimed: index < 2, today: index === 2 }));
  const hour = 3_600_000;
  const examples: { id: WidgetId; size: WidgetSize; ready: boolean; view: ReactNode }[] = [
    { id: "daily", size: "hero", ready: true, view: <DailyView face={{ state: "ready", reward: { coins: 100, shards: 0 }, day: 3, days }} size="hero" now={now} /> },
    { id: "daily", size: "tile", ready: false, view: <DailyView face={{ state: "waiting", next: { coins: 120, shards: 0 }, untilMs: now + 5 * hour, days }} size="tile" now={now} /> },
    { id: "daily", size: "tile", ready: false, view: <DailyView face={{ state: "idle" }} size="tile" now={now} /> },
    { id: "wheel", size: "hero", ready: true, view: <WheelView face={{ state: "ready", jackpot: 1_000 }} size="hero" now={now} /> },
    { id: "wheel", size: "tile", ready: false, view: <WheelView face={{ state: "ad", vip: false, jackpot: 1_000 }} size="tile" now={now} /> },
    { id: "wheel", size: "tile", ready: false, view: <WheelView face={{ state: "ad", vip: true, jackpot: 1_000 }} size="tile" now={now} /> },
    { id: "wheel", size: "tile", ready: false, view: <WheelView face={{ state: "cooldown", untilMs: now + hour / 5 }} size="tile" now={now} /> },
    { id: "wheel", size: "tile", ready: false, view: <WheelView face={{ state: "waiting", untilMs: now + 5 * hour, jackpot: 1_000 }} size="tile" now={now} /> },
    { id: "tasks", size: "hero", ready: true, view: <TasksView face={{ state: "ready", claimable: 2, done: 2, total: 4 }} size="hero" /> },
    { id: "tasks", size: "tile", ready: false, view: <TasksView face={{ state: "progress", done: 1, total: 4 }} size="tile" /> },
    { id: "friends", size: "tile", ready: false, view: <FriendsView face={{ state: "news", count: 2 }} size="tile" /> },
    { id: "record", size: "hero", ready: false, view: <RecordView face={{ state: "gap", bestSec: 754, gapSec: 42 }} size="hero" difficulty={t("difficulty.normal.name")} /> },
    { id: "record", size: "tile", ready: false, view: <RecordView face={{ state: "record", bestSec: 754 }} size="tile" difficulty={t("difficulty.normal.name")} /> },
    { id: "record", size: "tile", ready: false, view: <RecordView face={{ state: "none" }} size="tile" difficulty={t("difficulty.normal.name")} /> },
    { id: "friends", size: "row", ready: false, view: <FriendsView face={{ state: "idle" }} size="row" /> },
    { id: "tasks", size: "row", ready: false, view: <TasksView face={{ state: "idle" }} size="row" /> },
  ];
  return (
    <div className="grid grid-cols-2 gap-3">
      {examples.map((example, index) => (
        <Frame key={index} id={example.id} size={example.size} index={index} ready={example.ready}>
          {example.view}
        </Frame>
      ))}
    </div>
  );
}
