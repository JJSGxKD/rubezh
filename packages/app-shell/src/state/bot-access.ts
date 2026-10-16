import { z } from "zod/mini";
import { create } from "zustand";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { createPersistedValue } from "./persisted";
import { reportError, track, useShell } from "./shell";

/**
 * Разрешение боту писать (tasks/T-0010). Бот пишет только тем, кто начинал с
 * ним разговор или дал разрешение; большинство игроков открывают игру кнопкой
 * и до них не доходят заявки, подарки и сообщения команды.
 *
 * Зовём один раз после первого забега — игре уже есть за что доверять — и
 * дальше не чаще раза в две недели, всего трижды: после отказа настойчивость
 * только злит. Счёт и дата живут на устройстве. Всегда доступно в настройках,
 * пока разрешения нет.
 *
 * Есть ли разрешение, знает сервер (`GET /api/v1/me/messaging`): не
 * ответил — не знаем и не спрашиваем. После «Разрешить» клиент считает
 * разрешение полученным сразу: служебное сообщение до сервера идёт секунды.
 */

/** Не чаще раза в 14 дней. */
export const ASK_AGAIN_AFTER_MS = 14 * 86_400_000;

/** Всего показов просьбы — потом не зовём. */
export const MAX_ASKS = 3;

export const BOT_ACCESS_ASKS_KEY = "bh.bot-access-asks.v1";

export type BotAccessPlace = "lobby" | "settings";
export type BotAccessResult = "allowed" | "declined" | "unavailable";

export interface BotAccessAsks {
  count: number;
  lastAt: number | null;
}

const asksSchema = z.object({ count: z.number(), lastAt: z.nullable(z.number()) });
const viewSchema = z.object({ canMessage: z.boolean() });

const NO_ASKS: BotAccessAsks = { count: 0, lastAt: null };

export interface BotAccessStore {
  /** `null` — сервер не ответил: не знаем */
  canMessage: boolean | null;
  asks: BotAccessAsks;
}

export const useBotAccess = create<BotAccessStore>()(() => ({ canMessage: null, asks: NO_ASKS }));

const persisted = () =>
  createPersistedValue({
    storage: useShell.getState().storage,
    key: BOT_ACCESS_ASKS_KEY,
    schema: asksSchema,
    fallback: NO_ASKS,
    onBroken: (key, reason) => reportError("bot-access", `${key}: ${reason}`),
  });

/** Прочитать счёт показов с устройства — при запуске. */
export function hydrateBotAccess(): void {
  useBotAccess.setState({ asks: persisted().read() });
}

/**
 * Звать ли игрока разрешить боту писать: площадка умеет, сервер подтвердил,
 * что разрешения нет, игрок сыграл, и просьбой не надоели.
 */
export function shouldOfferBotAccess(input: { runs: number; canMessage: boolean | null; supported: boolean; asks: BotAccessAsks; now: number }): boolean {
  const { runs, canMessage, supported, asks, now } = input;
  if (!supported || canMessage !== false || runs < 1) return false;
  if (asks.count >= MAX_ASKS) return false;
  return asks.lastAt === null || now - asks.lastAt >= ASK_AGAIN_AFTER_MS;
}

export interface BotAccessApi {
  mine(): Promise<ApiResult<{ canMessage: boolean }>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createBotAccessApi(request: ApiRequest = apiRequest): BotAccessApi {
  return { mine: () => request("/api/v1/me/messaging", viewSchema, { method: "GET" }) };
}

/** Спросить сервер; не ответил — остаётся прежнее («не знаем» или последний ответ). */
export async function loadBotAccess(api?: BotAccessApi): Promise<void> {
  if (api === undefined && useShell.getState().capabilities.auth === undefined) return;
  const response = await (api ?? createBotAccessApi()).mine();
  if (response.ok) useBotAccess.setState({ canMessage: response.data.canMessage });
}

/** Умеет ли площадка просить разрешение — по наличию метода адаптера. */
export function botAccessSupported(): boolean {
  return useShell.getState().adapter?.requestBotMessages !== undefined;
}

function countAsk(now: number): void {
  const asks = { count: useBotAccess.getState().asks.count + 1, lastAt: now };
  useBotAccess.setState({ asks });
  persisted().write(asks);
}

/**
 * Показать системное окно. «Разрешить» — разрешение считается полученным
 * сразу; отказ, закрытое окно и тишина — счёт +1: просьбу показали, и
 * считать её нужно так же, как «Не сейчас».
 */
export async function requestBotAccess(place: BotAccessPlace, now = Date.now()): Promise<BotAccessResult> {
  const request = useShell.getState().adapter?.requestBotMessages;
  if (request === undefined) return "unavailable";
  track("bot_access_offered", { place });
  let result: BotAccessResult;
  try {
    result = await request.call(useShell.getState().adapter);
  } catch (error: unknown) {
    reportError("bot-access", error instanceof Error ? error.message : "запрос разрешения не удался");
    result = "unavailable";
  }
  track("bot_access_result", { place, result });
  if (result === "allowed") useBotAccess.setState({ canMessage: true });
  else if (result === "declined") countAsk(now);
  return result;
}

/** «Не сейчас» — просьбу показали и отложили; площадку не зовём. */
export function dismissBotAccess(now = Date.now()): void {
  countAsk(now);
}
