import type { ToolsAccess } from "@bh/shared-types";
import { create } from "zustand";
import { z } from "zod/mini";
import { apiRequest, type ApiFailure } from "./api-request";
import { useShell } from "./shell";

/**
 * Что открыто игроку из инструментов команды (docs/28-diagnostics.md §2.3):
 * режим разработчика и стресс-тест. Решает сервер — по праву `tools.dev` и
 * настройке «Стресс-тест для всех игроков»; запрос идёт под сессией аккаунта.
 */

const accessSchema = z.object({ admin: z.boolean(), stressTest: z.boolean(), devMode: z.boolean() });

export interface ToolsStore {
  /** что открыто игроку; `null` — сервер ещё не ответил или его нет */
  access: ToolsAccess | null;
  loadAccess(): Promise<ApiFailure | null>;
}

export const useTools = create<ToolsStore>((set) => ({
  access: null,

  async loadAccess(): Promise<ApiFailure | null> {
    if (useShell.getState().capabilities.auth === undefined) return "disabled";
    const response = await apiRequest("/api/v1/tools/access", accessSchema, { method: "GET" });
    if (!response.ok) return response.failure;
    set({ access: response.data });
    return null;
  },
}));

/**
 * Что открыто в клиенте с учётом сборки. Dev-сервер открывает всё: команда
 * правит режим разработчика в браузере, часто без поднятого бэкенда. В сборке
 * решает только сервер.
 */
export function effectiveAccess(access: ToolsAccess | null, devTools: boolean): ToolsAccess {
  if (devTools) return { admin: true, stressTest: true, devMode: true };
  return access ?? { admin: false, stressTest: false, devMode: false };
}

export function useToolsAccess(): ToolsAccess {
  const access = useTools((state) => state.access);
  const devTools = useShell((state) => state.capabilities.devTools === true);
  return effectiveAccess(access, devTools);
}
