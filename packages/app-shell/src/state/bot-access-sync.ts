import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { BOT_ACCESS_ASKS_KEY, NO_ASKS, useBotAccess, type BotAccessPlace, type BotAccessResult } from "./bot-access";
import { createPersistedValue } from "./persisted";
import { reportError, track, useShell } from "./shell";

/**
 * Чтение и запись разрешения боту писать (tasks/T-0010): счёт просьб на
 * устройстве, ответ сервера, системное окно площадки. Приезжает чанком
 * главной и настроек; состояние и правило показа — `bot-access.ts`.
 */

const asksSchema = z.object({ count: z.number(), lastAt: z.nullable(z.number()) });
const viewSchema = z.object({ canMessage: z.boolean() });

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
