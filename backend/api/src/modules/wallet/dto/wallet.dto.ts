import { z } from "zod";
import { PLATFORM_IDS } from "../../../platforms/ports/platform.js";
import { WALLET_MAX_OPERATION } from "../wallet-limits.js";
import { WALLET_RESOURCES } from "../wallet-types.js";

/**
 * Граница кошелька (docs/35-stage4-plan.md, WP3). Игрок кошелёк только
 * читает: начисляют забеги, задания и покупки на сервере, а не запрос
 * клиента.
 */

/**
 * Чей кошелёк — идентификатором аккаунта или на площадке: пока в панели нет
 * списка игроков, человека находят по его Telegram ID.
 */
const targetShape = {
  accountId: z.string().uuid().optional(),
  platformUserId: z.string().min(1).max(32).optional(),
  platform: z.enum(PLATFORM_IDS).default("telegram"),
};

const hasTarget = (value: { accountId?: string | undefined; platformUserId?: string | undefined }): boolean =>
  value.accountId !== undefined || value.platformUserId !== undefined;

export const walletLookupSchema = z
  .object({ ...targetShape, limit: z.coerce.number().int().min(1).max(200).default(50) })
  .refine(hasTarget, { message: "нужен accountId или platformUserId" });

export const walletAdjustSchema = z
  .object({
    ...targetShape,
    resource: z.enum(WALLET_RESOURCES),
    delta: z
      .number()
      .int()
      .min(-WALLET_MAX_OPERATION)
      .max(WALLET_MAX_OPERATION)
      .refine((value) => value !== 0, { message: "изменение не может быть нулевым" }),
    note: z.string().trim().min(3).max(200),
    // Ключ задаёт панель — повторное нажатие той же кнопки не начислит дважды.
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  })
  .refine(hasTarget, { message: "нужен accountId или platformUserId" });

export type WalletLookup = z.infer<typeof walletLookupSchema>;
export type WalletAdjust = z.infer<typeof walletAdjustSchema>;
