import { create } from "zustand";
import { z } from "zod/mini";
import { apiRequest, type ApiFailure, type ApiRequest, type ApiResult } from "./api-request";
import { useShell } from "./shell";

/**
 * Кошелёк игрока с сервера (docs/35-stage4-plan.md, WP3): монеты и
 * самоцветы в шапке. Клиент кошелёк только показывает — начисляет сервер за
 * забеги, задания и покупки, а счёт на устройстве был бы заявлением, а не
 * фактом.
 *
 * Сборка без авторизации (MAX, VK, тесты) не спрашивает ничего: там в шапке
 * нули, как было до экономики.
 */

export interface WalletBalances {
  coins: number;
  gems: number;
}

// Осколки и новые ресурсы сервер добавит в тот же ответ — схема их
// пропускает, а не падает: клиент мог не обновиться.
const walletSchema = z.object({ balances: z.object({ coins: z.number(), gems: z.number() }) });

export interface WalletApi {
  balances(): Promise<ApiResult<{ balances: WalletBalances }>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createWalletApi(request: ApiRequest = apiRequest): WalletApi {
  return { balances: () => request("/api/v1/wallet", walletSchema, { method: "GET" }) };
}

interface WalletState {
  /** `null` — ещё не спрашивали или сервер не ответил */
  balances: WalletBalances | null;
  load(api?: WalletApi): Promise<ApiFailure | null>;
}

export const useWallet = create<WalletState>()((set) => ({
  balances: null,

  async load(api) {
    if (api === undefined && useShell.getState().capabilities.auth === undefined) return "disabled";
    const response = await (api ?? createWalletApi()).balances();
    if (!response.ok) return response.failure;
    set({ balances: { coins: response.data.balances.coins, gems: response.data.balances.gems } });
    return null;
  },
}));
