import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Игроки в панели (`/admin/players`, docs/35-stage4-plan.md, WP17, часть 1).
 * Схемы описывают то, что панель показывает; лишние поля сервера отбрасываются,
 * а изменившийся тип поля — ошибка разбора, а не `undefined` в таблице.
 * Даты приходят строками ISO в UTC.
 */

const iso = z.string();
const isoOrNull = z.string().nullable();

export const playerRowSchema = z.object({
  accountId: z.string(),
  platform: z.string(),
  displayName: z.string(),
  photoUrl: z.string().nullable(),
  createdAt: iso,
  banned: z.object({ at: iso, reason: z.string().nullable() }).nullable(),
  /** идентификатор на площадке и юзернейм — сервер отдаёт их только с правом на персональные данные */
  pii: z.object({ platformUserId: z.string(), username: z.string().nullable() }).nullable(),
});

export const FUNNEL_MILESTONES = [
  ["enteredAt", "Вход"],
  ["appOpenedAt", "Открыл приложение"],
  ["firstRunStartedAt", "Начал первый забег"],
  ["firstRunFinishedAt", "Закончил первый забег"],
  ["runs2At", "Второй забег"],
  ["runs5At", "Пятый забег"],
  ["returnedD1At", "Вернулся на следующий день"],
  ["returnedD7At", "Вернулся через неделю"],
  ["firstPurchaseAt", "Первая покупка"],
] as const;

const funnelSchema = z.object({
  enteredAt: isoOrNull,
  appOpenedAt: isoOrNull,
  firstRunStartedAt: isoOrNull,
  firstRunFinishedAt: isoOrNull,
  runsRecorded: z.number(),
  runs2At: isoOrNull,
  runs5At: isoOrNull,
  returnedD1At: isoOrNull,
  returnedD7At: isoOrNull,
  firstPurchaseAt: isoOrNull,
});

const acquisitionSchema = z.object({
  firstAt: iso,
  firstStartKind: z.string(),
  firstStartRef: z.string().nullable(),
  lastSeenAt: iso,
  lastTouchAt: isoOrNull,
  lastStartKind: z.string().nullable(),
  lastStartRef: z.string().nullable(),
});

const runsSchema = z.object({
  runs: z.number(),
  totalKills: z.number(),
  totalSurvivalSec: z.number(),
  best: z.record(z.string(), z.object({ survivalSec: z.number(), rank: z.number() }).nullable()),
  recent: z.array(z.object({ difficultyId: z.string(), survivalSec: z.number(), level: z.number(), startingWeaponId: z.string(), at: z.number() })),
});

const walletEntrySchema = z.object({
  entryId: z.string(),
  resource: z.string(),
  amount: z.number(),
  reason: z.string(),
  source: z.string().nullable(),
  createdAt: iso,
});

const purchaseSchema = z.object({
  purchaseId: z.string(),
  runId: z.string(),
  continueNo: z.number(),
  priceStars: z.number(),
  chargedStars: z.number(),
  mode: z.string(),
  status: z.string(),
  invoicedAt: iso,
  paidAt: isoOrNull,
  refundReason: z.string().nullable(),
  refundedAt: isoOrNull,
});

export const playerCardSchema = z.object({
  account: playerRowSchema,
  roles: z.array(z.string()),
  funnel: funnelSchema.nullable(),
  acquisition: acquisitionSchema.nullable(),
  messaging: z.object({ canMessage: z.boolean(), reason: z.string(), changedAt: iso }).nullable(),
  progress: z.object({ level: z.number(), xp: z.number(), xpIntoLevel: z.number(), xpForNext: z.number().nullable() }),
  runs: runsSchema,
  wallet: z.object({ balances: z.record(z.string(), z.number()), entries: z.array(walletEntrySchema) }),
  /** `null` — у вошедшего нет права на платежи: модератор видит карточку без них */
  purchases: z.array(purchaseSchema).nullable(),
});

export const banResultSchema = z.object({ account: playerRowSchema, revokedSessions: z.number() });
export const adjustResultSchema = z.object({ applied: z.number(), balance: z.number(), duplicate: z.boolean() });

export type PlayerRow = z.infer<typeof playerRowSchema>;
export type PlayerCard = z.infer<typeof playerCardSchema>;
export type BanResult = z.infer<typeof banResultSchema>;
export type AdjustResult = z.infer<typeof adjustResultSchema>;

/** Ресурсы кошелька — в порядке и с именами, как их видит игрок. Неизвестный показывается своим id. */
export const WALLET_RESOURCES: readonly (readonly [string, string])[] = [
  ["coins", "Монеты"],
  ["gems", "Самоцветы"],
  ["shard_common", "Осколки: обычные"],
  ["shard_uncommon", "Осколки: необычные"],
  ["shard_rare", "Осколки: редкие"],
  ["shard_epic", "Осколки: эпические"],
  ["shard_legendary", "Осколки: легендарные"],
];

export function resourceName(id: string): string {
  return WALLET_RESOURCES.find(([resource]) => resource === id)?.[1] ?? id;
}

export interface WalletAdjust {
  resource: string;
  delta: number;
  note: string;
  /** ключ задаёт панель: повторное нажатие той же кнопки не начислит дважды */
  idempotencyKey: string;
}

export function searchPlayers(api: AdminApi, query: string): Promise<ApiResult<{ players: PlayerRow[] }>> {
  return api.request("/players", { query: { query, limit: 50 }, schema: z.object({ players: z.array(playerRowSchema) }) });
}

export function fetchPlayerCard(api: AdminApi, accountId: string): Promise<ApiResult<PlayerCard>> {
  return api.request(`/players/${encodeURIComponent(accountId)}`, { schema: playerCardSchema });
}

export function banPlayer(api: AdminApi, accountId: string, reason: string): Promise<ApiResult<BanResult>> {
  return api.request(`/players/${encodeURIComponent(accountId)}/ban`, { method: "POST", body: { reason }, schema: banResultSchema });
}

export function unbanPlayer(api: AdminApi, accountId: string): Promise<ApiResult<BanResult>> {
  return api.request(`/players/${encodeURIComponent(accountId)}/unban`, { method: "POST", schema: banResultSchema });
}

export function adjustWallet(api: AdminApi, accountId: string, adjust: WalletAdjust): Promise<ApiResult<AdjustResult>> {
  return api.request(`/players/${encodeURIComponent(accountId)}/wallet/adjust`, { method: "POST", body: adjust, schema: adjustResultSchema });
}

/**
 * Потолок одной операции — тот же, что `WALLET_MAX_OPERATION` на сервере.
 * Разойдутся — сервер отклонит, и панель покажет его текст: решает он.
 */
export const WALLET_MAX_OPERATION = 10_000_000;

/**
 * Проверка формы ручной операции до отправки — те же границы, что у сервера
 * (`adminWalletAdjustSchema`): не отправлять заведомо отклонённое. `null` —
 * форма годна.
 */
export function walletAdjustProblem(delta: number, note: string, maxOperation = WALLET_MAX_OPERATION): string | null {
  if (!Number.isInteger(delta) || delta === 0) return "Изменение — целое число, не ноль";
  if (Math.abs(delta) > maxOperation) return `Не больше ${maxOperation.toLocaleString("ru-RU")} за одну операцию`;
  const length = note.trim().length;
  if (length < 3 || length > 200) return "Причина — от 3 до 200 символов: она попадёт в журнал кошелька и в аудит";
  return null;
}
