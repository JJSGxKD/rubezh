import { createStore, type StoreApi } from "zustand/vanilla";
import type { AdminApi, ApiError } from "../api/client";
import { fetchIdentity, loginAsDeveloper, logout, type AdminIdentity } from "../api/session";

/**
 * Сессия панели. Токена здесь нет и быть не может: он в `HttpOnly` cookie, и
 * панель узнаёт о сессии только ответом сервера.
 *
 * - `loading` — спрашиваем сервер, кто мы;
 * - `anonymous` — входа нет; `notice` — почему выкинуло (сессия истекла);
 * - `blocked` — войти нельзя вовсе: панель выключена, API недоступен, вход
 *   закрыт. Экран с причиной и повтором, а не форма входа;
 * - `ready` — вошли.
 */
export type SessionView =
  | { status: "loading" }
  | { status: "anonymous"; notice: string | null; loginError: ApiError | null; pending: boolean }
  | { status: "blocked"; error: ApiError }
  | { status: "ready"; identity: AdminIdentity };

export interface SessionState {
  view: SessionView;
  restore(): Promise<void>;
  loginDev(devUser: string): Promise<void>;
  logout(): Promise<void>;
}

export type SessionStore = StoreApi<SessionState>;

const anonymous = (notice: string | null = null, loginError: ApiError | null = null): SessionView => ({ status: "anonymous", notice, loginError, pending: false });

export function createSessionStore(api: AdminApi): SessionStore {
  const store = createStore<SessionState>()((set, get) => ({
    view: { status: "loading" },

    async restore() {
      set({ view: { status: "loading" } });
      const result = await fetchIdentity(api);
      if (result.ok) return set({ view: { status: "ready", identity: result.data } });
      // 401 — просто нет входа; остальное — причина, по которой входить некуда.
      set({ view: result.error.kind === "unauthorized" ? anonymous() : { status: "blocked", error: result.error } });
    },

    async loginDev(devUser) {
      const current = get().view;
      if (current.status === "anonymous") set({ view: { ...current, pending: true, loginError: null } });
      const result = await loginAsDeveloper(api, devUser.trim());
      if (result.ok) return set({ view: { status: "ready", identity: result.data } });
      if (result.error.kind === "disabled" || result.error.kind === "offline") return set({ view: { status: "blocked", error: result.error } });
      set({ view: anonymous(null, result.error) });
    },

    async logout() {
      // Выход считается и при ошибке сети: на этом устройстве панель
      // закрывается сразу, а cookie истечёт сама по сроку.
      await logout(api);
      set({ view: anonymous() });
    },
  }));

  // Любой запрос раздела, получивший 401, возвращает панель ко входу.
  api.onUnauthorized(() => {
    if (store.getState().view.status === "ready") store.setState({ view: anonymous("Сессия истекла — войдите снова") });
  });

  return store;
}

/** Есть ли у вошедшего право — для того, чтобы спрятать недоступное. */
export function can(view: SessionView, permission: string): boolean {
  return view.status === "ready" && view.identity.permissions.includes(permission);
}
