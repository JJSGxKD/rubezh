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
  /** ник, как он пришёл с площадки; сервер старее T-0151 поля не отдаёт */
  platformName: z.string().nullable().default(null),
  /** ник закреплён модератором: вход его не меняет */
  nameLocked: z.boolean().default(false),
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
  /** до магазина (WP10) сервер поля не отдавал — всё было вторым шансом */
  product: z.string().optional(),
  runId: z.string().nullable(),
  continueNo: z.number().nullable(),
  sku: z.string().nullable().optional(),
  /** продление подписки — первая её покупка; до VIP (WP10) сервер поля не отдавал */
  renewalOf: z.string().nullable().optional(),
  priceStars: z.number(),
  chargedStars: z.number(),
  mode: z.string(),
  status: z.string(),
  invoicedAt: iso,
  paidAt: isoOrNull,
  refundReason: z.string().nullable(),
  /** когда товар лёг игроку; у второго шанса не бывает никогда — он засчитан в забеге */
  fulfilledAt: isoOrNull.optional(),
  /** возврат заказан, звёзды ещё в пути */
  refundRequestedAt: isoOrNull.optional(),
  refundedAt: isoOrNull,
  /** что поддержка может сделать сейчас (T-0037); старый сервер поля не отдаёт. Строками: действие новее панели не должно ронять карточку */
  actions: z.array(z.string()).default([]),
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
  /** предупреждение об открытом тесте (WP33); сервер старее панели поля не пришлёт */
  testNotice: z.object({ version: z.number(), acceptedAt: iso, firstAcceptedAt: iso }).nullable().optional(),
});

export const adjustResultSchema = z.object({ applied: z.number(), balance: z.number(), duplicate: z.boolean() });

export type PlayerRow = z.infer<typeof playerRowSchema>;
export type PlayerCard = z.infer<typeof playerCardSchema>;
export type PlayerPurchase = z.infer<typeof purchaseSchema>;
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

export function adjustWallet(api: AdminApi, accountId: string, adjust: WalletAdjust): Promise<ApiResult<AdjustResult>> {
  return api.request(`/players/${encodeURIComponent(accountId)}/wallet/adjust`, { method: "POST", body: adjust, schema: adjustResultSchema });
}

const nameResultSchema = z.object({ account: playerRowSchema });

/** Сменить ник и закрепить (право `players.ban`): сервер чистит ник, отказ приходит текстом причины. */
export function renamePlayer(api: AdminApi, accountId: string, name: string): Promise<ApiResult<z.infer<typeof nameResultSchema>>> {
  return api.request(`/players/${encodeURIComponent(accountId)}/name`, { method: "POST", body: { name }, schema: nameResultSchema });
}

/** Снять закрепление: ник снова берётся с площадки. */
export function unlockPlayerName(api: AdminApi, accountId: string): Promise<ApiResult<z.infer<typeof nameResultSchema>>> {
  return api.request(`/players/${encodeURIComponent(accountId)}/name/unlock`, { method: "POST", body: {}, schema: nameResultSchema });
}

/** Ник с площадки отличается от показываемого — чистка его изменила или модератор сменил вручную. */
export function nameDiffers(account: Pick<PlayerRow, "displayName" | "platformName">): boolean {
  return account.platformName !== null && account.platformName.trim() !== account.displayName;
}

/** Пределы причины действия с покупкой — те же, что у сервера (`purchaseSupportSchema`). */
export const PURCHASE_NOTE_MIN = 3;
export const PURCHASE_NOTE_MAX = 200;

/** `null` — причину можно отправлять. */
export function purchaseNoteProblem(note: string): string | null {
  const length = note.trim().length;
  if (length < PURCHASE_NOTE_MIN) return "Причина — от 3 символов: она попадёт в журнал действий и в сообщение команде";
  if (length > PURCHASE_NOTE_MAX) return "Причина — до 200 символов";
  return null;
}

const REFUND_REASONS: Readonly<Record<string, string>> = {
  test_mode: "тестовая оплата",
  unused: "второй шанс не использован",
  external: "вернули вне игры",
  undeliverable: "товара нет в каталоге",
  manual: "вручную, поддержка",
};

export function refundReasonLabel(reason: string | null): string {
  if (reason === null) return "—";
  return REFUND_REASONS[reason] ?? reason;
}

export type PurchaseStateTone = "neutral" | "success" | "warning" | "info";

/** Что с покупкой сейчас — словами для таблицы; порядок проверок важен: возврат сильнее выдачи. */
export function purchaseState(purchase: Pick<PlayerPurchase, "paidAt" | "refundedAt"> & Partial<Pick<PlayerPurchase, "product" | "fulfilledAt" | "refundRequestedAt">>): { label: string; tone: PurchaseStateTone } {
  if (purchase.paidAt === null) return { label: "не оплачен", tone: "neutral" };
  if (purchase.refundedAt !== null) return { label: "звёзды возвращены", tone: "neutral" };
  if (purchase.refundRequestedAt !== undefined && purchase.refundRequestedAt !== null) return { label: "возврат в пути", tone: "info" };
  if (purchase.fulfilledAt !== undefined && purchase.fulfilledAt !== null) return { label: "выдан", tone: "success" };
  if (purchase.product === undefined || purchase.product === "continue_run") return { label: "оплачен", tone: "success" };
  return { label: "не выдан", tone: "warning" };
}

const supportResultSchema = z.object({ purchase: purchaseSchema, actions: z.array(z.string()) });
export type SupportResult = z.infer<typeof supportResultSchema>;

function purchaseAction(api: AdminApi, accountId: string, purchaseId: string, action: "refund" | "fulfill", note: string): Promise<ApiResult<SupportResult>> {
  return api.request(`/players/${encodeURIComponent(accountId)}/purchases/${encodeURIComponent(purchaseId)}/${action}`, { method: "POST", body: { note }, schema: supportResultSchema });
}

/** Вернуть звёзды; причина попадёт в журнал действий и в поток «Покупки». */
export function refundPurchase(api: AdminApi, accountId: string, purchaseId: string, note: string): Promise<ApiResult<SupportResult>> {
  return purchaseAction(api, accountId, purchaseId, "refund", note);
}

/** Повторить выдачу; у выдачи свой ключ — дважды ничего не начислится. */
export function fulfillPurchase(api: AdminApi, accountId: string, purchaseId: string, note: string): Promise<ApiResult<SupportResult>> {
  return purchaseAction(api, accountId, purchaseId, "fulfill", note);
}

/** Потолок сообщения команды — тот же, что `TEAM_MESSAGE_MAX` на сервере. */
export const TEAM_MESSAGE_MAX = 500;

export const messageResultSchema = z.object({ duplicate: z.boolean() });

/** Сообщение команды в ленту игрока; ключ задаёт панель — повтор кнопки второй строки не заведёт. */
export function messagePlayer(api: AdminApi, accountId: string, message: { text: string; idempotencyKey: string }): Promise<ApiResult<z.infer<typeof messageResultSchema>>> {
  return api.request(`/players/${encodeURIComponent(accountId)}/message`, { method: "POST", body: message, schema: messageResultSchema });
}

/** Проверка сообщения до отправки — те же границы, что у сервера; `null` — годно. */
export function teamMessageProblem(text: string, max = TEAM_MESSAGE_MAX): string | null {
  const length = text.trim().length;
  return length < 3 || length > max ? `Сообщение — от 3 до ${String(max)} символов` : null;
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

/** Друзья и рефералка игрока (`GET /admin/players/:id/social`). */
export const socialSchema = z.object({
  friends: z.number(),
  referredBy: z
    .object({
      referrerId: z.string(),
      referrerName: z.string().nullable(),
      status: z.string(),
      boundAt: iso,
      activatedAt: isoOrNull,
      rejectReason: z.string().nullable(),
    })
    .nullable(),
  /** привёл партнёр своим кодом; сервер старше партнёров поля не шлёт */
  partner: z
    .object({ partnerId: z.string(), name: z.string(), boundAt: iso, campaignTitle: z.string().nullable(), code: z.string().nullable() })
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  referrals: z.object({ bound: z.number(), activated: z.number(), rejected: z.number() }),
});

export type Social = z.infer<typeof socialSchema>;

export const REFERRAL_STATUSES: Record<string, string> = { bound: "ждёт активации", activated: "активирован", rejected: "отклонён" };

export function fetchSocial(api: AdminApi, accountId: string): Promise<ApiResult<Social>> {
  return api.request(`/players/${encodeURIComponent(accountId)}/social`, { schema: socialSchema });
}

export function rejectReferral(api: AdminApi, accountId: string, reason: string): Promise<ApiResult<{ rejected: boolean }>> {
  return api.request(`/players/${encodeURIComponent(accountId)}/referral/reject`, { method: "POST", body: { reason }, schema: z.object({ rejected: z.boolean() }) });
}

/** Что куплено — словами: второй шанс с номером продолжения, товар магазина или донат. */
export function purchaseLabel(purchase: Pick<PlayerPurchase, "product" | "sku" | "continueNo" | "renewalOf">): string {
  // До проверки sku: у доната он задан («donation»), но это не товар магазина.
  if (purchase.product === "donation") return "донат";
  if (purchase.product === "vip") return purchase.renewalOf === null || purchase.renewalOf === undefined ? "VIP" : "VIP, продление";
  if (purchase.sku !== null && purchase.sku !== undefined) return `магазин: ${purchase.sku}`;
  return purchase.continueNo === null ? "—" : `второй шанс №${String(purchase.continueNo)}`;
}
