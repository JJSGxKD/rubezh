import type { DailyView } from "../daily/daily.service.js";
import type { TaskView } from "../tasks/tasks.service.js";
import type { WheelView } from "../wheel/wheel.service.js";

/**
 * Виджеты главной (docs/35-stage4-plan.md WP42, часть 3): награда дня,
 * колесо и задания — ровно то, что рисует главная, а не весь ответ их
 * экранов. Порядок и размер виджетов решает клиент по знакам меню: после
 * забора на соседнем экране они свежее этого ответа.
 *
 * Источник, который не ответил, — `null`: виджет остаётся на месте и ведёт
 * на свой экран, только без подробностей.
 */

export interface DailyWidget {
  canClaim: boolean;
  /** семь дней недели: что забрано и какой сегодня; седьмой виден заранее */
  days: { coins: number; shards: number; claimed: boolean; today: boolean }[];
  /** что ждёт завтра после сегодняшнего забора */
  next: { coins: number; shards: number };
}

export interface WheelWidget {
  /** бесплатная крутка суток ждёт */
  free: boolean;
  /** самый крупный монетный сектор — «до 1 000 монет»; монет на колесе нет — `null` */
  jackpot: number | null;
  /** крутка за рекламу: есть ли она на площадке, когда пройдёт кулдаун, VIP — без ролика */
  ad: { available: boolean; readyAt: string | null; vip: boolean };
}

export interface TasksWidget {
  /** задания суток: выполнено из скольких — кольцо «2/4» */
  dailyDone: number;
  dailyTotal: number;
  /** выполнено, но награда не забрана — на всех вкладках, как знак меню */
  claimable: number;
}

export interface HomeWidgets {
  daily: DailyWidget | null;
  wheel: WheelWidget | null;
  tasks: TasksWidget | null;
}

export function dailyWidget(view: DailyView): DailyWidget {
  return {
    canClaim: view.canClaim,
    days: view.days.map(({ coins, shards, claimed, today }) => ({ coins, shards, claimed, today })),
    next: view.next,
  };
}

export function wheelWidget(view: WheelView): WheelWidget {
  const coins = view.sectors.flatMap((sector) => (sector.resource === "coins" ? [sector.amount] : []));
  return {
    free: view.free,
    jackpot: coins.length === 0 ? null : Math.max(...coins),
    // Имя пропуска главной ни к чему: ей важно только, нужен ли ролик.
    ad: { available: view.ad.available, readyAt: view.ad.readyAt, vip: view.ad.pass !== null },
  };
}

export function tasksWidget(tasks: readonly TaskView[]): TasksWidget {
  const daily = tasks.filter((task) => task.category === "daily");
  return {
    dailyDone: daily.filter((task) => task.done).length,
    dailyTotal: daily.length,
    claimable: tasks.filter((task) => task.done && !task.claimed).length,
  };
}
