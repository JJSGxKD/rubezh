import { create } from "zustand";
import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { useConnection } from "./connection";
import { useShell } from "./shell";

/**
 * Лента живых событий на главной (Р114, docs/35-stage4-plan.md; tasks/T-0176):
 * «кто-то только что…» — настоящие события за сутки, которые собирает сервер
 * (`GET /api/v1/feed`, T-0174). Клиент ничего не придумывает и не достраивает.
 *
 * Лента — украшение, а не функция: нет входа, нет сети, ответ не разобрался —
 * строки просто нет, и ошибка игроку не показывается. Незнакомый вид события
 * (сервер новее клиента) отбрасывается по одному, а не роняет всю ленту — как
 * слайды главной (`home-api.ts`).
 *
 * Модуль едет с чанком главной — первой загрузке он не нужен.
 */

export const FEED_KINDS = ["long_run", "week_record", "boss", "chest"] as const;

export type FeedKind = (typeof FEED_KINDS)[number];

export interface FeedItem {
  id: string;
  kind: FeedKind;
  /** как в рейтинге; обрезано до `FEED_NAME_MAX` */
  name: string;
  /** когда событие случилось, мс */
  atMs: number;
  /** время забега: у `long_run` и `week_record` */
  seconds: number | null;
}

export interface FeedData {
  items: FeedItem[];
  /** как часто спрашивать ленту, пока открыта главная */
  refreshSec: number;
}

export const FEED_NAME_MAX = 64;

/**
 * Частота опроса приходит с сервера (`feed.refresh-sec`), но клиент ей не
 * верит вслепую: сервер новее или ошибся — опрашивать каждую секунду он не
 * начнёт, а раз в сутки лента устарела бы вся.
 */
export const FEED_REFRESH_MIN_SEC = 60;
export const FEED_REFRESH_MAX_SEC = 3_600;

const KIND_WITH_SECONDS: ReadonlySet<FeedKind> = new Set(["long_run", "week_record"]);

/** Вид читается строкой: незнакомый отбрасывает только своё событие. */
const eventSchema = z.object({
  id: z.string().check(z.minLength(1)),
  kind: z.string(),
  name: z.string(),
  at: z.string(),
  seconds: z.nullable(z.number()),
});

const viewSchema = z.object({
  events: z.array(z.unknown()),
  refreshSec: z.number(),
});

function isFeedKind(kind: string): kind is FeedKind {
  return (FEED_KINDS as readonly string[]).includes(kind);
}

/** По кодовым точкам, а не по единицам UTF-16: эмодзи в имени не разрезается пополам. */
function clipName(name: string): string {
  const letters = Array.from(name.trim());
  return letters.length > FEED_NAME_MAX ? letters.slice(0, FEED_NAME_MAX).join("") : letters.join("");
}

/** Одно событие ответа; `null` — показать его честно нечем, и оно отбрасывается. */
function toItem(raw: unknown): FeedItem | null {
  const result = eventSchema.safeParse(raw);
  if (!result.success) return null;
  const { id, kind, name, at, seconds } = result.data;
  if (!isFeedKind(kind)) return null;
  const atMs = Date.parse(at);
  const shown = clipName(name);
  if (Number.isNaN(atMs) || shown === "") return null;
  // «12 мин в одном забеге» без минут — выдумка: такое событие не показываем.
  if (KIND_WITH_SECONDS.has(kind) && (seconds === null || seconds < 0)) return null;
  return { id, kind, name: shown, atMs, seconds };
}

export interface FeedApi {
  feed(): Promise<ApiResult<FeedData>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createFeedApi(request: ApiRequest = apiRequest): FeedApi {
  return {
    async feed() {
      const response = await request("/api/v1/feed", viewSchema, { method: "GET" });
      if (!response.ok) return response;
      const { events, refreshSec } = response.data;
      return {
        ok: true,
        data: {
          items: events.flatMap((raw) => {
            const item = toItem(raw);
            return item === null ? [] : [item];
          }),
          refreshSec: Math.min(FEED_REFRESH_MAX_SEC, Math.max(FEED_REFRESH_MIN_SEC, refreshSec)),
        },
      };
    },
  };
}

/** Лента собрана по аккаунту: гостю без входа её не из чего показать. */
export function feedAvailable(): boolean {
  return useShell.getState().capabilities.auth !== undefined;
}

export interface FeedState {
  items: FeedItem[];
  refreshSec: number;
  /** когда за лентой пошли в последний раз удачно; 0 — ещё не приходила */
  askedAt: number;
}

/** До первого ответа лента спрашивается раз в пять минут — умолчание сервера (`feed.refresh-sec`). */
export const FEED_REFRESH_DEFAULT_SEC = 300;

export const useFeed = create<FeedState>()(() => ({ items: [], refreshSec: FEED_REFRESH_DEFAULT_SEC, askedAt: 0 }));

let inflight: Promise<void> | null = null;

/**
 * Освежить ленту. Прежняя остаётся на экране, пока идёт новая, и при ошибке:
 * устаревшие события отсеивает показ (`home-feed-rules.ts`), а не стор. Без
 * входа и без сети запроса нет; два слота спрашивают разом — запрос один.
 */
export function refreshFeed(now = Date.now(), api: FeedApi = createFeedApi()): Promise<void> {
  if (!feedAvailable() || useConnection.getState().status === "offline") return Promise.resolve();
  if (inflight !== null) return inflight;
  inflight = api
    .feed()
    .then((response) => {
      if (response.ok) useFeed.setState({ items: response.data.items, refreshSec: response.data.refreshSec, askedAt: now });
    })
    .catch((error: unknown) => {
      console.warn("Лента событий не обновилась:", error);
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function forgetFeedForTests(): void {
  inflight = null;
  useFeed.setState({ items: [], refreshSec: FEED_REFRESH_DEFAULT_SEC, askedAt: 0 });
}
