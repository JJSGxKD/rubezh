import { z } from "zod";

/** Граница раздела друзей: идентификатор другого игрока — только uuid аккаунта. */
export const friendIdSchema = z.string().uuid();
export const friendRequestSchema = z.object({ accountId: friendIdSchema });
