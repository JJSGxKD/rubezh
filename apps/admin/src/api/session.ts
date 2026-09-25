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

export function logout(api: AdminApi): Promise<ApiResult<{ loggedOut: true }>> {
  return api.request("/session/logout", { method: "POST", schema: z.object({ loggedOut: z.literal(true) }) });
}
