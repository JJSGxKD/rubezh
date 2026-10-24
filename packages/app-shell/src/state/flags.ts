import { create } from "zustand";
import { z } from "zod/mini";
import { apiRequest, type ApiRequest } from "./api-request";

/**
 * Флаги клиента — `GET /api/v1/flags` после входа (backend `flags.controller.ts`).
 * Флаги заводятся и включаются в панели («Флаги»): доля игроков и площадки —
 * правило флага на сервере, клиент лишь спрашивает и прячет выключенное.
 * Решает всё равно сервер.
 *
 * Модуль общий: следующие флаги клиента берутся отсюда же. Нет входа, обрыв
 * сети, отказ или битый ответ — все флаги выключены: игра идёт так, как будто
 * флагов нет.
 */

/** Арт получают все, кому флаг включён. */
export const FLAG_ART_ALL = "art.sprites";
/** Арт получают только тестеры (`tester` в ответе входа, Р87). */
export const FLAG_ART_TESTERS = "art.sprites.testers";

const flagsSchema = z.object({ flags: z.record(z.string(), z.boolean()) });

export interface FlagsState {
  flags: Readonly<Record<string, boolean>>;
  /** тестер ли игрок — на момент последней загрузки флагов */
  tester: boolean;
}

export const useFlags = create<FlagsState>(() => ({ flags: {}, tester: false }));

/** Для тестов и смены аккаунта: всё выключено. */
export function resetFlags(): void {
  useFlags.setState({ flags: {}, tester: false });
}

/**
 * Загрузить флаги игрока. Не бросает: любая неудача выключает всё. `request`
 * подменяется в тестах — сеть и сессия им не нужны.
 */
export async function loadFlags(request: ApiRequest = apiRequest): Promise<void> {
  const response = await request("/api/v1/flags", flagsSchema, { method: "GET" });
  if (!response.ok) {
    resetFlags();
    return;
  }
  // Сессия уже подгружена самим запросом: статический импорт утащил бы её в
  // первую загрузку (`pnpm budget`).
  const { useSession } = await import("./session");
  useFlags.setState({ flags: response.data.flags, tester: useSession.getState().account?.tester === true });
}

export function isFlagOn(key: string): boolean {
  return useFlags.getState().flags[key] === true;
}

function allowed(state: FlagsState): boolean {
  return state.flags[FLAG_ART_ALL] === true || (state.flags[FLAG_ART_TESTERS] === true && state.tester);
}

/**
 * Доступен ли игроку черновой арт: флаг для всех **или** флаг для тестеров и
 * игрок — тестер. Так переход «тестерам → всем» — включение второго флага без
 * релиза (docs/35-stage4-plan.md, Р143).
 */
export function draftArtAllowed(): boolean {
  return allowed(useFlags.getState());
}

/** То же для экрана: строка в «Графике» появляется, когда флаги пришли. */
export function useDraftArtAllowed(): boolean {
  return useFlags(allowed);
}
