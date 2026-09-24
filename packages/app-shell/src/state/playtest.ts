import type { PlaytestAccess } from "@bh/shared-types";
import { create } from "zustand";
import { z } from "zod/mini";
import { apiRequest, type ApiFailure } from "./api-request";
import { useInstall } from "./install";
import { useShell } from "./shell";

/**
 * Плейтест после переезда забегов на аккаунты (docs/34-stage3-plan.md, WP4):
 * что открыто игроку и отчёт о запуске для сводки. Забеги и рейтинг —
 * `state/runs.ts`. Оба запроса идут под сессией аккаунта.
 */

const PREFIX = "/api/v1/playtest";

const accessSchema = z.object({ admin: z.boolean(), stressTest: z.boolean(), devMode: z.boolean() });
const sessionSchema = z.object({ recorded: z.boolean() });

export interface PlaytestStore {
  /** что открыто игроку; `null` — сервер ещё не ответил или его нет */
  access: PlaytestAccess | null;
  loadAccess(): Promise<ApiFailure | null>;
  /**
   * Сообщить о запуске: сколько людей открыли игру и на чём. Без очереди —
   * пропущенный запуск статистику не исказит, а копить их незачем.
   */
  reportSession(): Promise<ApiFailure | null>;
}

export const usePlaytest = create<PlaytestStore>((set) => ({
  access: null,

  async loadAccess(): Promise<ApiFailure | null> {
    if (!enabled()) return "disabled";
    const response = await apiRequest(`${PREFIX}/access`, accessSchema, { method: "GET" });
    if (!response.ok) return response.failure;
    set({ access: response.data });
    return null;
  },

  async reportSession(): Promise<ApiFailure | null> {
    const { adapter, build } = useShell.getState();
    const installId = useInstall.getState().installId;
    if (!enabled() || installId === "") return "disabled";
    // Разбор устройства — отдельным чанком: отчёт о запуске уходит после
    // главной и первую загрузку ждать не должен.
    const { describeDevice } = await import("./device");
    const response = await apiRequest(`${PREFIX}/sessions`, sessionSchema, {
      method: "POST",
      body: { installId, build: build.version, contentHash: build.contentHash, device: describeDevice(adapter.clientInfo()) },
    });
    return response.ok ? null : response.failure;
  },
}));

/**
 * Что открыто в клиенте с учётом сборки. Dev-сервер открывает всё: команда
 * правит режим разработчика в браузере, часто без поднятого бэкенда. В сборке
 * решает только сервер.
 */
export function effectiveAccess(access: PlaytestAccess | null, devTools: boolean): PlaytestAccess {
  if (devTools) return { admin: true, stressTest: true, devMode: true };
  return access ?? { admin: false, stressTest: false, devMode: false };
}

export function usePlaytestAccess(): PlaytestAccess {
  const access = usePlaytest((state) => state.access);
  const devTools = useShell((state) => state.capabilities.devTools === true);
  return effectiveAccess(access, devTools);
}

function enabled(): boolean {
  return useShell.getState().capabilities.auth !== undefined;
}
