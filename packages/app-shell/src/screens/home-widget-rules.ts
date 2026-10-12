import type { DifficultyId } from "@bh/shared-types";
import type { DailyWidget, TasksWidget, WheelWidget } from "../state/home-api";
import type { LastRun } from "../state/meta";
import { msUntilReset } from "./meta/schedule";

/**
 * Виджеты главной (docs/35-stage4-plan.md WP42, часть 3, Р76): что в каком
 * порядке и каким размером стоит и что каждый говорит — правилом, без
 * разметки, чтобы его проверял модульный тест.
 *
 * **Порядок и размер.** Готовое к забору — первым и во всю ширину: награда
 * дня, колесо, задания — в таком порядке, награда дня копится неделей и
 * пропуск обиднее всего. Остальное — плитками по две в ряд: рекорд и
 * задания, потом ждущие с отсчётом, последними — друзья. Ничего не готово —
 * первым во всю ширину рекорд: о нём и стоит напомнить перед «Играть».
 * Плиток нечётное число — последняя растягивается в строку, дыр в сетке нет.
 *
 * Что готово, решают знаки меню, а не ответ главной: после забора на
 * соседнем экране знаки обновляются сразу, а ответ главной — следом.
 */

export type WidgetId = "daily" | "wheel" | "tasks" | "record" | "friends";

/** `hero` — во всю ширину и выше; `tile` — плитка в полряда; `row` — во всю ширину высотой плитки. */
export type WidgetSize = "hero" | "tile" | "row";

export interface WidgetSlot {
  id: WidgetId;
  size: WidgetSize;
}

/** Готово к забору прямо сейчас — по знакам меню. */
export interface WidgetReadiness {
  daily: boolean;
  wheel: boolean;
  tasks: boolean;
}

const READY_ORDER = ["daily", "wheel", "tasks"] as const;
const REST_ORDER: readonly WidgetId[] = ["record", "tasks", "daily", "wheel", "friends"];

export function arrangeWidgets(ready: WidgetReadiness): WidgetSlot[] {
  const first: WidgetSlot[] = READY_ORDER.filter((id) => ready[id]).map((id) => ({ id, size: "hero" }));
  const rest: WidgetSlot[] = REST_ORDER.filter((id) => !first.some((slot) => slot.id === id)).map((id) => ({ id, size: "tile" }));
  const lead = rest[0];
  if (first.length === 0 && lead !== undefined) lead.size = "hero";
  const tiles = rest.filter((slot) => slot.size === "tile");
  const last = tiles.at(-1);
  if (tiles.length % 2 === 1 && last !== undefined) last.size = "row";
  return [...first, ...rest];
}

/** Состояние виджета — словом: так оно уходит в `home_widget_clicked`. */
export type DailyFace =
  | { state: "ready"; reward: Amount | null; day: number | null; days: readonly DayMark[] }
  | { state: "waiting"; next: Amount | null; untilMs: number; days: readonly DayMark[] }
  | { state: "idle" };

export interface Amount {
  coins: number;
  shards: number;
}

export interface DayMark {
  claimed: boolean;
  today: boolean;
  /** седьмой день — крупнее и с осколками: виден заранее */
  coins: number;
  shards: number;
}

/**
 * Награда дня. Знак говорит «ждёт», а ответ главной ещё вчерашний (полночь
 * прошла на главной) — сегодня забирают то, что вчера было «завтра».
 * Знак погас, а в ответе награда ещё не забрана (забрали на экране награды
 * дня) — завтра всё равно `next`: следующий день по порядку один и тот же.
 */
export function dailyFace(widget: DailyWidget | null, ready: boolean, nowMs: number): DailyFace {
  if (widget === null) return ready ? { state: "ready", reward: null, day: null, days: [] } : { state: "idle" };
  if (!ready) return { state: "waiting", next: widget.next, untilMs: nowMs + msUntilReset(nowMs, "daily"), days: widget.days };
  if (!widget.canClaim) return { state: "ready", reward: widget.next, day: null, days: [] };
  const index = widget.days.findIndex((day) => day.today);
  const today = widget.days[index];
  return { state: "ready", reward: today === undefined ? null : { coins: today.coins, shards: today.shards }, day: index < 0 ? null : index + 1, days: widget.days };
}

export type WheelFace =
  | { state: "ready"; jackpot: number | null }
  | { state: "ad"; vip: boolean; jackpot: number | null }
  | { state: "cooldown"; untilMs: number }
  | { state: "waiting"; untilMs: number; jackpot: number | null }
  | { state: "idle" };

/**
 * Колесо. Бесплатная крутка ждёт — по знаку. Потрачена — крутка за рекламу,
 * если она есть на площадке и её можно показать (у VIP — без ролика), иначе
 * отсчёт до новых суток. `playable` — площадка умеет показывать ролики.
 */
export function wheelFace(widget: WheelWidget | null, ready: boolean, nowMs: number, playable: boolean): WheelFace {
  if (ready) return { state: "ready", jackpot: widget?.jackpot ?? null };
  if (widget === null) return { state: "idle" };
  const { ad } = widget;
  if (ad.available && (ad.vip || playable)) {
    const readyAt = ad.readyAt === null ? Number.NaN : Date.parse(ad.readyAt);
    if (Number.isFinite(readyAt) && readyAt > nowMs) return { state: "cooldown", untilMs: readyAt };
    return { state: "ad", vip: ad.vip, jackpot: widget.jackpot };
  }
  return { state: "waiting", untilMs: nowMs + msUntilReset(nowMs, "daily"), jackpot: widget.jackpot };
}

export type TasksFace = { state: "ready"; claimable: number; done: number | null; total: number | null } | { state: "progress"; done: number; total: number } | { state: "idle" };

/** Задания. Сколько наград ждёт — по знаку: он свежее ответа главной. */
export function tasksFace(widget: TasksWidget | null, claimable: number): TasksFace {
  if (claimable > 0) return { state: "ready", claimable, done: widget?.dailyDone ?? null, total: widget === null || widget.dailyTotal === 0 ? null : widget.dailyTotal };
  if (widget === null || widget.dailyTotal === 0) return { state: "idle" };
  return { state: "progress", done: Math.min(widget.dailyDone, widget.dailyTotal), total: widget.dailyTotal };
}

export type RecordFace =
  | { state: "none" }
  | { state: "record"; bestSec: number }
  | { state: "gap"; bestSec: number; gapSec: number }
  | { state: "best"; bestSec: number; runs: number };

/**
 * Рекорд — на выбранной сложности: время на разных сложностях несравнимо.
 * Последний забег на ней же — сколько не хватило или «рекорд — в нём»;
 * на другой сложности или не было — сколько забегов сыграно.
 */
export function recordFace(best: number, difficultyId: DifficultyId, lastRun: LastRun | null, runs: number): RecordFace {
  if (best <= 0) return { state: "none" };
  if (lastRun === null || lastRun.difficultyId !== difficultyId) return { state: "best", bestSec: best, runs };
  const gap = Math.floor(best) - Math.floor(lastRun.survivalSec);
  return gap <= 0 ? { state: "record", bestSec: best } : { state: "gap", bestSec: best, gapSec: gap };
}

export type FriendsFace = { state: "news"; count: number } | { state: "idle" };

/** Друзья: подарки и заявки ждут — числом со знака меню. */
export function friendsFace(count: number): FriendsFace {
  return count > 0 ? { state: "news", count } : { state: "idle" };
}
