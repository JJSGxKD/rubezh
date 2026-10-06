import { createStore, type StoreApi } from "zustand/vanilla";
import type { AdminApi, ApiError } from "../api/client";
import { fetchIdentity, loginAsDeveloper, logout, openBotLogin, pollBotLogin, type AdminIdentity, type BotLoginPoll } from "../api/session";

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
  | { status: "anonymous"; notice: string | null; loginError: ApiError | null; pending: boolean; bot: BotLoginView }
  | { status: "blocked"; error: ApiError }
  | { status: "ready"; identity: AdminIdentity };

/**
 * Вход через бота (docs/29-admin-panel.md §8): код на экране, ссылка на бота,
 * ожидание подтверждения. Сессию сервер ставит cookie при первом опросе после
 * «Войти» в боте.
 */
export type BotLoginView =
  | { status: "idle" }
  | { status: "opening" }
  | { status: "waiting"; code: string; link: string; expiresAtMs: number }
  | { status: "failed"; message: string };

export interface SessionState {
  view: SessionView;
  restore(): Promise<void>;
  loginDev(devUser: string): Promise<void>;
  /** Открыть вход через бота и ждать подтверждения — до успеха, отказа, срока или отмены. */
  loginBot(): Promise<void>;
  cancelBot(): void;
  logout(): Promise<void>;
}

/** Часы и ожидание — подменяются в тестах, чтобы не ждать настоящие секунды. */
export interface SessionTiming {
  pollMs: number;
  now(): number;
  wait(ms: number): Promise<void>;
}

const TIMING: SessionTiming = {
  pollMs: 2_000,
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const BOT_REFUSALS: Record<Extract<BotLoginPoll, { status: "declined" }>["reason"], string> = {
  declined: "Вход отклонён в боте. Если это были не вы — просто закройте запрос.",
  no_role: "У этого аккаунта нет роли в панели — попросите владельца выдать её в разделе «Роли».",
  banned: "Аккаунт заблокирован — с него в панель не войти.",
};

export type SessionStore = StoreApi<SessionState>;

const anonymous = (notice: string | null = null, loginError: ApiError | null = null, bot: BotLoginView = { status: "idle" }): SessionView => ({
  status: "anonymous",
  notice,
  loginError,
  pending: false,
  bot,
});

export function createSessionStore(api: AdminApi, timing: SessionTiming = TIMING): SessionStore {
  // Номер попытки входа через бота: отмена и новая попытка гасят опрос прежней.
  let botAttempt = 0;

  const store = createStore<SessionState>()((set, get) => {
    /** Состояние входа через бота — только пока мы на форме входа и попытка всё ещё эта. */
    const setBot = (attempt: number, bot: BotLoginView) => {
      const view = get().view;
      if (attempt === botAttempt && view.status === "anonymous") set({ view: { ...view, bot } });
    };

    return {
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

      async loginBot() {
        const attempt = ++botAttempt;
        setBot(attempt, { status: "opening" });
        const opened = await openBotLogin(api);
        if (!opened.ok) {
          if (opened.error.kind === "disabled") return set({ view: { status: "blocked", error: opened.error } });
          return setBot(attempt, { status: "failed", message: opened.error.message });
        }
        const expiresAtMs = Date.parse(opened.data.expiresAt);
        setBot(attempt, { status: "waiting", code: opened.data.code, link: opened.data.link, expiresAtMs });

        while (attempt === botAttempt) {
          await timing.wait(timing.pollMs);
          if (attempt !== botAttempt) return;
          if (timing.now() > expiresAtMs) return setBot(attempt, { status: "failed", message: "Время вышло — начните вход заново" });
          const result = await pollBotLogin(api, opened.data);
          // Сеть моргнула — пробуем снова на следующем шаге: запрос ещё жив.
          if (!result.ok && result.error.kind === "offline") continue;
          if (!result.ok) return setBot(attempt, { status: "failed", message: result.error.message });
          const poll = result.data;
          if (poll.status === "pending") continue;
          if (poll.status === "confirmed") {
            botAttempt++;
            return set({ view: { status: "ready", identity: poll.identity } });
          }
          return setBot(attempt, { status: "failed", message: poll.status === "declined" ? BOT_REFUSALS[poll.reason] : "Запрос истёк — начните вход заново" });
        }
      },

      cancelBot() {
        const attempt = ++botAttempt;
        setBot(attempt, { status: "idle" });
      },

      async logout() {
        // Выход считается и при ошибке сети: на этом устройстве панель
        // закрывается сразу, а cookie истечёт сама по сроку.
        await logout(api);
        set({ view: anonymous() });
      },
    };
  });

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
