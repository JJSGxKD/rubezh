import { z } from "zod";

/**
 * Событие ленты на главной (Р114, docs/35-stage4-plan.md; tasks/T-0174): то,
 * что настоящие игроки сделали за последние сутки. Лента — витрина в Redis,
 * а не аналитика: событий в `analytics_event` она не порождает.
 *
 * Виды `boss` и `chest` берутся из счётчиков итога забега (tasks/T-0175):
 * убит хотя бы один босс и открыт хотя бы один редкий сундук.
 */
export const FEED_KINDS = ["long_run", "week_record", "boss", "chest"] as const;

export type FeedKind = (typeof FEED_KINDS)[number];

export interface FeedEvent {
  /** `<runId>:<kind>` — идемпотентность записи */
  id: string;
  kind: FeedKind;
  /** наружу не выходит */
  accountId: string;
  /** `finishedAt` забега, мс */
  atMs: number;
  /** время забега в секундах: у `long_run` и `week_record`; у `boss` и `chest` — null */
  seconds: number | null;
}

/** Разбор записи из Redis: данные с границы системы не приводятся через `as`. */
export const feedEventSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(FEED_KINDS),
  accountId: z.string().min(1).max(64),
  atMs: z.number().int().nonnegative(),
  seconds: z.number().nonnegative().nullable(),
});

/**
 * Член отсортированного множества — стабильная строка: порядок полей зафиксирован,
 * поэтому повтор того же события даёт ту же строку и `ZADD NX` его не дублирует.
 */
export function encodeFeedEvent(event: FeedEvent): string {
  return JSON.stringify({ id: event.id, kind: event.kind, accountId: event.accountId, atMs: event.atMs, seconds: event.seconds });
}

/** Что уходит клиенту: без `accountId` и сырого `runId`. */
export interface FeedEventView {
  /** `sha1(id)`, первые 12 знаков: нужен клиенту как ключ строки */
  id: string;
  kind: FeedKind;
  name: string;
  /** ISO 8601 */
  at: string;
  seconds: number | null;
}

export interface FeedView {
  events: FeedEventView[];
  /** как часто клиент спрашивает ленту, пока открыта главная */
  refreshSec: number;
}
