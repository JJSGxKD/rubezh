import { create } from "zustand";
import { useShell } from "./shell";

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
 * Модуль — только состояние и правило показа: он едет с первой загрузкой, на
 * главной нужен «звать ли». Запрос, чтение с сервера и устройства — в
 * `screens/home-bot-access.tsx`, чанком главной и настроек.
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

export const NO_ASKS: BotAccessAsks = { count: 0, lastAt: null };

export interface BotAccessStore {
  /** `null` — сервер не ответил: не знаем */
  canMessage: boolean | null;
  asks: BotAccessAsks;
}

export const useBotAccess = create<BotAccessStore>()(() => ({ canMessage: null, asks: NO_ASKS }));

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

/** Умеет ли площадка просить разрешение — по наличию метода адаптера. */
export function botAccessSupported(): boolean {
  return useShell.getState().adapter?.requestBotMessages !== undefined;
}

