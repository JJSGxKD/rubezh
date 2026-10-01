import { z } from "zod";
import { PLATFORM_IDS } from "../../../platforms/ports/platform.js";
import { TEAM_MESSAGE_MAX } from "../../notifications/notification-kinds.js";
import { isRole, ROLES } from "../../roles/permissions.js";
import { WALLET_MAX_OPERATION } from "../../wallet/wallet-limits.js";
import { WALLET_RESOURCES } from "../../wallet/wallet-types.js";

/**
 * Граница панели (docs/35-stage4-plan.md, WP17). Всё, что приходит из
 * браузера администратора, разбирается схемой так же строго, как запросы
 * игрока: панель — не доверенный клиент, а ещё один клиент.
 */

const limit = (max: number, fallback: number) => z.coerce.number().int().min(1).max(max).default(fallback);

export const adminDevLoginSchema = z.object({ devUser: z.string().min(1).max(128) });

/** Опрос входа через бота: номер запроса и секрет открывшей его вкладки. */
export const panelLoginPollSchema = z.object({ requestId: z.string().min(1).max(64), secret: z.string().min(1).max(128) });

export const accountIdSchema = z.string().uuid();

export const playerSearchSchema = z.object({
  query: z.string().trim().min(1).max(64),
  limit: limit(50, 20),
});

export const banSchema = z.object({ reason: z.string().trim().min(3).max(256) });

/** Ручная операция с кошельком — то же тело, что у `wallet/admin/adjust`, но игрок уже в пути. */
export const adminWalletAdjustSchema = z.object({
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
});

/** Сообщение команды в ленту игрока: ключ кнопки — повтор после обрыва сети второй строки не заведёт. */
export const playerMessageSchema = z.object({
  text: z.string().trim().min(3).max(TEAM_MESSAGE_MAX),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
});

/**
 * Цель выдачи роли — идентификатором аккаунта или на площадке: человека из
 * команды проще найти по его Telegram ID, чем по uuid.
 */
export const roleTargetSchema = z
  .object({
    accountId: z.string().uuid().optional(),
    platformUserId: z.string().min(1).max(32).optional(),
    platform: z.enum(PLATFORM_IDS).default("telegram"),
    role: z.string().refine(isRole, { message: `роль — одна из: ${ROLES.join(", ")}` }),
  })
  .refine((value) => value.accountId !== undefined || value.platformUserId !== undefined, {
    message: "нужен accountId или platformUserId",
  });

/**
 * Страница журнала аудита: курсор — время и id последней показанной записи
 * (`2026-10-01T20:56:00.123Z_<uuid>`), виды действий — началами имён через
 * запятую (`roles.,admin.login`), человек — id аккаунта, объект — как его
 * пишет действие. Пустое — без отбора.
 */
export const auditQuerySchema = z.object({
  limit: limit(200, 50),
  before: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z_[0-9a-f-]{36}$/i)
    .transform((value) => {
      const [createdAt = "", entryId = ""] = value.split("_");
      return { createdAt: new Date(createdAt), entryId: entryId.toLowerCase() };
    })
    .refine((cursor) => !Number.isNaN(cursor.createdAt.getTime()), { message: "курсор — время и id записи" })
    .optional(),
  actions: z
    .string()
    .max(200)
    .transform((value) => value.split(",").filter((prefix) => prefix !== ""))
    .pipe(z.array(z.string().regex(/^[a-z][a-z_.]{0,63}$/)).max(12))
    .optional(),
  actor: z.string().uuid().optional(),
  target: z.string().min(1).max(128).optional(),
});
export const reviewLimitSchema = limit(200, 50);
export const exportsLimitSchema = limit(100, 20);

/** Период — датами ISO в query; пусто — последние тридцать дней, границы решает сервис. */
export const periodQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const reportsListSchema = z.object({
  kind: z.enum(["bench", "run"]).optional(),
  platform: z.enum(PLATFORM_IDS).optional(),
  appVersion: z.string().trim().min(1).max(64).optional(),
  before: z.coerce.date().optional(),
  limit: limit(200, 50),
});

export const reportIdSchema = z.string().uuid();

export type PlayerSearch = z.infer<typeof playerSearchSchema>;
export type AdminWalletAdjust = z.infer<typeof adminWalletAdjustSchema>;
export type RoleTarget = z.infer<typeof roleTargetSchema>;
export type PeriodQuery = z.infer<typeof periodQuerySchema>;
export type ReportsList = z.infer<typeof reportsListSchema>;
