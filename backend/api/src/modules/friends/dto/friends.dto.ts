import { z } from "zod";
import { publicIdSchema } from "../../../common/public-identity.js";

/** Граница раздела друзей: идентификатор другого игрока — только uuid аккаунта. */
export const friendIdSchema = z.string().uuid();

/**
 * Заявка в друзья: игрока называют внутренним id (друзья и заявки, где клиент его уже знает) или
 * публичным (карточка игрока, рейтинг — там внутреннего id нет). Ровно одно из двух: строгие
 * объекты не пускают оба поля сразу, а пустое тело не подходит ни одному.
 */
export const friendRequestSchema = z.union([
  z
    .object({ accountId: friendIdSchema })
    .strict()
    .transform((body) => ({ by: "account" as const, accountId: body.accountId })),
  z
    .object({ publicId: publicIdSchema })
    .strict()
    .transform((body) => ({ by: "public" as const, publicId: body.publicId })),
]);
