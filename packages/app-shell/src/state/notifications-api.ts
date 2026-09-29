import { z } from "zod/mini";
import { t } from "../i18n";
import "../i18n/account";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { useNotifications } from "./notifications";
import { useShell } from "./shell";

/**
 * Лента уведомлений с сервера (docs/35-stage4-plan.md Р51, §3.17): число
 * непрочитанного при входе, на возврате в приложение и после забега — без
 * постоянного соединения. Виды и данные — строками: сервер новее клиента
 * пришлёт вид, которого экран не знает, и лента не должна от этого падать.
 */

const itemSchema = z.object({
  id: z.string(),
  kind: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  read: z.boolean(),
});

const feedSchema = z.object({ items: z.array(itemSchema), nextCursor: z.nullable(z.string()), unread: z.number() });
const unreadSchema = z.object({ unread: z.number() });

export type NotificationItem = z.infer<typeof itemSchema>;
export type NotificationFeed = z.infer<typeof feedSchema>;

export interface NotificationsApi {
  feed(cursor: string | null): Promise<ApiResult<NotificationFeed>>;
  unread(): Promise<ApiResult<{ unread: number }>>;
  read(upTo: string | null): Promise<ApiResult<{ unread: number }>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createNotificationsApi(request: ApiRequest = apiRequest): NotificationsApi {
  return {
    feed: (cursor) => request(`/api/v1/me/notifications${cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`}`, feedSchema, { method: "GET" }),
    unread: () => request("/api/v1/me/notifications/unread", unreadSchema, { method: "GET" }),
    read: (upTo) => request("/api/v1/me/notifications/read", unreadSchema, { method: "POST", body: upTo === null ? {} : { upTo } }),
  };
}

function disabled(api: NotificationsApi | undefined): boolean {
  return api === undefined && useShell.getState().capabilities.auth === undefined;
}

export async function loadUnread(api?: NotificationsApi): Promise<void> {
  if (disabled(api)) return;
  const response = await (api ?? createNotificationsApi()).unread();
  if (response.ok) useNotifications.setState({ unread: response.data.unread });
}

export async function loadFeed(cursor: string | null, api?: NotificationsApi): Promise<ApiResult<NotificationFeed>> {
  if (disabled(api)) return { ok: false, failure: "disabled" };
  const response = await (api ?? createNotificationsApi()).feed(cursor);
  if (response.ok) useNotifications.setState({ unread: response.data.unread });
  return response;
}

/** Прочитано до уведомления, которое игрок видел: пришедшее позже останется новым. */
export async function markRead(upTo: string | null, api?: NotificationsApi): Promise<void> {
  if (disabled(api)) return;
  const response = await (api ?? createNotificationsApi()).read(upTo);
  if (response.ok) useNotifications.setState({ unread: response.data.unread });
}

let watching = false;

/**
 * Число — и на возврате в приложение: подарок друга, пришедший, пока игра была
 * свёрнута, виден без перезапуска.
 */
export function watchReturns(): void {
  if (watching || typeof document === "undefined") return;
  watching = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void loadUnread();
  });
}

/** Когда: свежее — «минут назад», давнее — датой. */
export function formatWhen(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.floor((nowMs - at) / 60_000));
  if (minutes < 1) return t("notifications.when.now");
  if (minutes < 60) return t("notifications.when.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("notifications.when.hours", { count: hours });
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" }).format(new Date(at));
}
