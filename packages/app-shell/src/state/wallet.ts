import { create } from "zustand";

/**
 * Кошелёк игрока в шапке (docs/35-stage4-plan.md, WP3) — только состояние.
 * Запрос к серверу — `wallet-api.ts`, отдельным чанком.
 */

export interface WalletBalances {
  coins: number;
  gems: number;
}

interface WalletState {
  /** `null` — ещё не спрашивали или сервер не ответил */
  balances: WalletBalances | null;
}

export const useWallet = create<WalletState>()(() => ({ balances: null }));
