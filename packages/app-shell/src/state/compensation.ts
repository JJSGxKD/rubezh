import { create } from "zustand";
import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { currentScreen, useNavigation } from "./navigation";
import { track } from "./shell";
import { loadWallet } from "./wallet-api";

/**
 * Компенсация тестеру после вайпа (docs/35-stage4-plan.md Р87, WP33): окно
 * «Спасибо за тест» при первом входе после вайпа. Что положено и сколько,
 * решает сервер (`/api/v1/me/compensation`): клиент показывает и просит
 * забрать, а повтор запроса сервер отвечает тем же результатом.
 *
 * Модуль грузится после входа — первой загрузке он не нужен.
 */

const viewSchema = z.object({
  tester: z.boolean(),
  level: z.number(),
  bonusGems: z.number(),
  restored: z.array(z.object({ resource: z.string(), amount: z.number() })),
  continueGems: z.number(),
});

const claimSchema = z.object({
  view: viewSchema,
  alreadyClaimed: z.boolean(),
  // Балансы клиент перечитывает кошельком (`loadWallet`): форма ответа ему не нужна.
  balances: z.record(z.string(), z.unknown()),
});

export type CompensationView = z.infer<typeof viewSchema>;
export type CompensationClaim = z.infer<typeof claimSchema>;

export interface CompensationApi {
  pending(): Promise<ApiResult<CompensationView | null>>;
  claim(): Promise<ApiResult<CompensationClaim>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createCompensationApi(request: ApiRequest = apiRequest): CompensationApi {
  return {
    pending: () => request("/api/v1/me/compensation", z.nullable(viewSchema), { method: "GET" }),
    claim: () => request("/api/v1/me/compensation/claim", claimSchema, { method: "POST" }),
  };
}

/** Ждущая компенсация: экран окна читает её отсюда. */
export const useCompensation = create<{ pending: CompensationView | null }>(() => ({ pending: null }));

let stopWaiting: (() => void) | null = null;

/** Компенсация ждёт — запомнить её и показать окно, как только игрок в лобби. */
export async function syncCompensation(api: CompensationApi = createCompensationApi()): Promise<void> {
  const response = await api.pending();
  if (!response.ok || response.data === null) return;
  useCompensation.setState({ pending: response.data });
  waitForLobby();
}

/** «Забрать»: `true` — забрано, окно можно закрыть; `false` — показать ошибку. */
export async function claimCompensation(api: CompensationApi = createCompensationApi()): Promise<boolean> {
  const response = await api.claim();
  if (!response.ok) return false;

  const { view, alreadyClaimed } = response.data;
  // Событие только с первого забора: повтор (сеть оборвалась после начисления)
  // ничего не начисляет и воронку исказил бы.
  if (!alreadyClaimed) {
    track("compensation_claimed", {
      tester: view.tester,
      bonusGems: view.bonusGems,
      restoredGems: compensationLines(view).restoredGems,
      continueGems: view.continueGems,
    });
  }
  useCompensation.setState({ pending: null });
  void loadWallet();
  return true;
}

export interface CompensationLines {
  restoredGems: number;
  continueGems: number;
  bonusGems: number;
  badge: boolean;
  total: number;
}

/**
 * Строки окна и сумма: только самоцветы. Купленное за звёзды возвращается по
 * ресурсам, но строка «Купленное за звёзды» в окне — самоцветы; монеты в
 * «Всего» не входят.
 */
export function compensationLines(view: CompensationView): CompensationLines {
  const restoredGems = view.restored.filter((entry) => entry.resource === "gems").reduce((sum, entry) => sum + entry.amount, 0);
  return {
    restoredGems,
    continueGems: view.continueGems,
    bonusGems: view.bonusGems,
    badge: view.tester,
    total: restoredGems + view.continueGems + view.bonusGems,
  };
}

/**
 * Экран — только в лобби и после предупреждения о тесте: поверх забега он
 * сорвал бы бой, а предупреждение обещает то, о чём окно уже рассказывает.
 * Оба ждут «верхний экран — лобби», и тот, кто лёг в стек первым, закрывается
 * раньше.
 */
function waitForLobby(): void {
  stopWaiting?.();
  const check = (): void => {
    if (useCompensation.getState().pending === null) {
      stop();
      return;
    }
    if (currentScreen(useNavigation.getState().stack) !== "lobby") return;
    stop();
    useNavigation.getState().push("testerThanks");
  };
  const unsubscribers = [useNavigation.subscribe(check), useCompensation.subscribe(check)];
  const stop = (): void => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    stopWaiting = null;
  };
  stopWaiting = stop;
  check();
}
