import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { useShell } from "./shell";

/**
 * Раздел «Друзья» с сервера (docs/35-stage4-plan.md §3.8, WP14): друзья,
 * заявки, подарки и бонус за число друзей. Правила и числа — у сервера:
 * клиент показывает, что можно сделать, а результат решает сервер.
 *
 * Модуль грузится вместе с экраном друзей — первой загрузке он не нужен.
 */

const peer = { accountId: z.string(), displayName: z.string(), photoUrl: z.nullable(z.string()) };

const friendSchema = z.object({ ...peer, since: z.string(), source: z.string() });
const requestSchema = z.object({ ...peer, at: z.string() });

const viewSchema = z.object({
  friends: z.array(friendSchema),
  incoming: z.array(requestSchema),
  outgoing: z.array(requestSchema),
  limits: z.object({ maxFriends: z.number() }),
  gifts: z.object({ sentToday: z.array(z.string()), pending: z.number(), claimableToday: z.number(), coins: z.number() }),
  bonus: z.object({
    qualified: z.number(),
    steps: z.array(z.object({ friends: z.number(), coins: z.number(), state: z.string() })),
    readyCoins: z.number(),
  }),
});

const claimSchema = z.object({ claimed: z.number(), coins: z.number() });
const linkSchema = z.object({ code: z.string(), startParam: z.string() });
const inviteMessageSchema = z.object({ messageId: z.string(), expiresAt: z.nullable(z.string()) });

export type FriendsView = z.infer<typeof viewSchema>;
export type FriendEntry = z.infer<typeof friendSchema>;
export type FriendRequestEntry = z.infer<typeof requestSchema>;
export type ClaimResult = z.infer<typeof claimSchema>;

export interface FriendsApi {
  view(): Promise<ApiResult<FriendsView>>;
  link(): Promise<ApiResult<{ code: string; startParam: string }>>;
  /** сообщение с кнопкой в игру, подготовленное ботом площадки (Р63) */
  inviteMessage(): Promise<ApiResult<{ messageId: string; expiresAt: string | null }>>;
  accept(accountId: string): Promise<ApiResult<unknown>>;
  decline(accountId: string): Promise<ApiResult<unknown>>;
  cancel(accountId: string): Promise<ApiResult<unknown>>;
  gift(accountId: string): Promise<ApiResult<{ sent: boolean }>>;
  remove(accountId: string): Promise<ApiResult<unknown>>;
  claimGifts(): Promise<ApiResult<ClaimResult>>;
  claimBonus(): Promise<ApiResult<ClaimResult>>;
}

const anything = z.unknown();

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createFriendsApi(request: ApiRequest = apiRequest): FriendsApi {
  const id = (accountId: string) => encodeURIComponent(accountId);
  const post = <T>(path: string, schema: z.ZodMiniType<T>) => request(`/api/v1/friends${path}`, schema, { method: "POST", body: {} });
  const remove = (path: string) => request(`/api/v1/friends${path}`, anything, { method: "DELETE" });
  return {
    view: () => request("/api/v1/friends", viewSchema, { method: "GET" }),
    link: () => post("/link", linkSchema),
    inviteMessage: () => post("/invite-message", inviteMessageSchema),
    accept: (accountId) => post(`/requests/${id(accountId)}/accept`, anything),
    decline: (accountId) => post(`/requests/${id(accountId)}/decline`, anything),
    cancel: (accountId) => remove(`/requests/${id(accountId)}`),
    gift: (accountId) => post(`/${id(accountId)}/gift`, z.object({ sent: z.boolean() })),
    remove: (accountId) => remove(`/${id(accountId)}`),
    claimGifts: () => post("/gifts/claim", claimSchema),
    claimBonus: () => post("/bonus/claim", claimSchema),
  };
}

/** Раздел работает только с входом: дружба бывает лишь между аккаунтами. */
export function friendsAvailable(): boolean {
  return useShell.getState().capabilities.auth !== undefined;
}

/**
 * Ссылка дружбы — она же приглашение (WP14): открывший её становится другом
 * позвавшего, а новичок ещё и засчитывается рефералом. Ссылка у аккаунта одна
 * и постоянная.
 */
export function friendInviteUrl(botUrl: string, startParam: string): string {
  return botUrl === "" ? "" : `${botUrl}?startapp=${encodeURIComponent(startParam)}`;
}
