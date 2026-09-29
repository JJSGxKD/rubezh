import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Кто вошёл и что ему открыто (`GET /admin/session`). Панель рисует разделы
 * по правам из этого ответа, но решает всегда сервер: скрытая кнопка — это
 * удобство, а не защита (docs/29-admin-panel.md §3.4).
 */
export const identitySchema = z.object({
  account: z.object({
    accountId: z.string(),
    platform: z.string(),
    displayName: z.string(),
    photoUrl: z.string().nullable(),
  }),
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
});

export type AdminIdentity = z.infer<typeof identitySchema>;

export function fetchIdentity(api: AdminApi): Promise<ApiResult<AdminIdentity>> {
  return api.request("/session", { schema: identitySchema });
}

/** Вход разработчика — «dev-<id>:Имя», только при `AUTH_DEV_LOGIN` на сервере. */
export function loginAsDeveloper(api: AdminApi, devUser: string): Promise<ApiResult<AdminIdentity>> {
  return api.request("/session/dev", { method: "POST", body: { devUser }, schema: identitySchema });
}

/** Вход через бота, шаг первый: код, ссылка на бота и секрет, по которому эта вкладка заберёт сессию. */
export const botLoginSchema = z.object({
  requestId: z.string(),
  secret: z.string(),
  code: z.string(),
  link: z.string().url(),
  expiresAt: z.string(),
});

export type BotLogin = z.infer<typeof botLoginSchema>;

export function openBotLogin(api: AdminApi): Promise<ApiResult<BotLogin>> {
  return api.request("/session/bot", { method: "POST", schema: botLoginSchema });
}

export const botLoginPollSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("expired") }),
  z.object({ status: z.literal("declined"), reason: z.enum(["declined", "no_role", "banned"]) }),
  z.object({ status: z.literal("confirmed"), identity: identitySchema }),
]);

export type BotLoginPoll = z.infer<typeof botLoginPollSchema>;

/** Шаг второй: подтвердили ли вход в боте. Подтвердили — сервер ставит cookie сессии. */
export function pollBotLogin(api: AdminApi, login: Pick<BotLogin, "requestId" | "secret">): Promise<ApiResult<BotLoginPoll>> {
  return api.request("/session/bot/poll", { method: "POST", body: { requestId: login.requestId, secret: login.secret }, schema: botLoginPollSchema });
}

export function logout(api: AdminApi): Promise<ApiResult<{ loggedOut: true }>> {
  return api.request("/session/logout", { method: "POST", schema: z.object({ loggedOut: z.literal(true) }) });
}
