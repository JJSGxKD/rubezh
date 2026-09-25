import { create } from "zustand";
import {
  AUTH_TIMEOUT_MS,
  createAuthApi,
  type AuthAccount,
  type AuthApi,
  type AuthApiConfig,
  type AuthFailure,
  type Session,
} from "./auth-api";
import { track, useShell } from "./shell";

/**
 * Сессия игрока (docs/34-stage3-plan.md, WP1). Перенос клиента с молчаливой
 * ре-авторизацией из `vpnsibcom_web` (docs/13-reuse-from-vpnsibcom.md §11).
 *
 * **Токены живут в памяти вкладки и никуда не сохраняются** (решение Р3):
 * WebView Telegram чистит хранилище непредсказуемо, особенно на iOS, и
 * сессия, положенная в `localStorage`, всё равно однажды исчезнет
 * (docs/33-telegram-mini-app-pitfalls.md §1.3). Потерялась — вход заново по
 * данным запуска, это одна незаметная игроку секунда.
 *
 * Поэтому же токены лежат здесь, а не в состоянии Zustand: в состояние
 * смотрят компоненты и инструменты разработчика, а токену там делать нечего.
 *
 * **Почему вход не на заставке.** Сессия нужна деньгам и рейтингу, а не
 * первому кадру: игра запускается без неё и доигрывает вход в фоне. Не
 * получилось — забег всё равно идёт, а сессия подхватится на следующем
 * запуске.
 */

/** Токен доступа обновляется заранее: на границе он протух бы посреди запроса. */
const RENEW_MARGIN_SEC = 60;

interface Tokens {
  access: string;
  refresh: string;
  /** когда токен доступа перестанет годиться, мс */
  expiresAtMs: number;
}

let tokens: Tokens | null = null;
/**
 * Один вход на все запросы сразу. Без этого десять параллельных отказов
 * устроили бы десять входов — и упёрлись бы в лимит частоты, который сами же
 * и выбили.
 */
let renewal: Promise<AuthFailure | null> | null = null;

export type SessionStatus = "idle" | "signing" | "ready" | "failed";

export interface SessionState {
  status: SessionStatus;
  account: AuthAccount | null;
  /** почему сессии нет; `null` — причина неизвестна или её не было */
  failure: AuthFailure | null;
  /**
   * Текст отказа от сервера — единственный текст здесь не из словаря: причину
   * блокировки знает только сервер, и придумать её на клиенте нельзя.
   */
  message: string | null;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}

export const useSession = create<SessionState>((set, get) => ({
  status: "idle",
  account: null,
  failure: null,
  message: null,

  async signIn(): Promise<void> {
    // Без проверки «уже входим»: параллельные вызовы ждут один и тот же
    // промис внутри `renew`, а сюда приходит уже готовый ответ.
    if (get().status !== "ready") set({ status: "signing" });
    await renew("launch");
  },

  async signOut(): Promise<void> {
    const api = authApi();
    const refresh = tokens?.refresh;
    tokens = null;
    set({ status: "idle", account: null, failure: null, message: null });
    if (api !== null && refresh !== undefined) await api.logout(refresh);
  },
}));

/**
 * Запрос от имени игрока: токен подставляется сам, протухший обновляется
 * молча. Забеги, отчёты о запуске и доступ идут через него (`api-request.ts`),
 * покупки этапа 3 — тоже.
 *
 * Повтор ровно один: если и после свежего входа сервер отвечает «не
 * авторизован», повторять бессмысленно — так делается цикл, а не сессия.
 */
export async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response | null> {
  const config = useShell.getState().capabilities.auth;
  if (config === undefined) return null;

  const failure = await ensureFresh();
  if (failure !== null) return null;

  const response = await send(config, path, init);
  if (response.status !== 401) return response;

  // Сервер считает токен негодным, хотя по нашим часам он свежий: разошлось
  // время или сессию отозвали. Пробуем ровно один раз.
  const renewed = await renew("reauth");
  if (renewed !== null) return response;
  return await send(config, path, init);
}

/** Сессия есть и протухнет не раньше, чем через запас. */
async function ensureFresh(): Promise<AuthFailure | null> {
  if (tokens !== null && Date.now() < tokens.expiresAtMs) return null;
  return await renew(tokens === null ? "launch" : "refresh");
}

/**
 * Обновить сессию: сперва по токену продления, а если его нет или он не
 * принят — заново по данным запуска площадки. Параллельные вызовы ждут один
 * и тот же промис.
 */
function renew(reason: "launch" | "refresh" | "reauth"): Promise<AuthFailure | null> {
  renewal ??= runRenewal(reason).finally(() => {
    renewal = null;
  });
  return renewal;
}

async function runRenewal(reason: "launch" | "refresh" | "reauth"): Promise<AuthFailure | null> {
  const api = authApi();
  if (api === null) return "disabled";

  if (tokens !== null) {
    const refreshed = await api.refresh(tokens.refresh);
    if (refreshed.ok) return accept(refreshed.data, reason);
    // Токен продления не принят — сессию сбросили или он устарел. Это не
    // конец: данные запуска у нас есть, входим заново.
    tokens = null;
    if (refreshed.failure === "banned") return reject(refreshed.failure, refreshed.message);
  }

  const { adapter, capabilities } = useShell.getState();
  const launchData = adapter.signedLaunchData();
  if (launchData === null || launchData === "") {
    // Мимо площадки входит только разработчик на dev-сервере: в сборку имя
    // не попадает, а бэкенд вне development такой вход не принимает.
    const devUser = capabilities.auth?.devUser ?? "";
    if (devUser === "") return reject("no_identity");
    const dev = await api.devLogin(devUser, loginReason(reason));
    if (!dev.ok) return reject(dev.failure, dev.message);
    return accept(dev.data, reason);
  }

  const login = await api.login(launchData, { client: adapter.clientInfo(), reason: loginReason(reason) });
  if (!login.ok) return reject(login.failure, login.message);
  return accept(login.data, reason);
}

function accept(session: Session, reason: "launch" | "refresh" | "reauth"): null {
  tokens = {
    access: session.accessToken,
    refresh: session.refreshToken,
    expiresAtMs: Date.now() + Math.max(session.expiresInSec - RENEW_MARGIN_SEC, 0) * 1000,
  };
  useSession.setState({ status: "ready", account: session.account, failure: null, message: null });

  // Регистрация — ровно один раз за жизнь аккаунта: о том, что он заведён
  // этим входом, знает только сервер.
  if (session.account.created) track("user_registered");
  track("user_authenticated", { reason });
  // Сессия — запуск игры, и откуда её открыли, говорит сервер по подписи:
  // сам клиент видит параметр запуска неподписанным (docs/34-stage3-plan.md, WP6).
  if (reason === "launch" && session.launch !== undefined) {
    track("session_started", { startKind: session.launch.startKind, first: session.account.created });
  }
  return null;
}

/**
 * Вход на запуске — новая сессия; вход посреди работы (продление не принято,
 * сервер не узнал токен) — та же сессия, и сервер не должен заводить вторую.
 */
function loginReason(reason: "launch" | "refresh" | "reauth"): "launch" | "reauth" {
  return reason === "launch" ? "launch" : "reauth";
}

function reject(failure: AuthFailure, message?: string): AuthFailure {
  useSession.setState({ status: "failed", failure, message: message ?? null });
  return failure;
}

/**
 * Запрос с токеном. Свой таймаут — когда вызывающий не принёс отмену: висящий
 * без срока запрос к API это забег, застрявший на «сохраняем».
 */
async function send(config: AuthApiConfig, path: string, init: RequestInit): Promise<Response> {
  const base = config.baseUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
  try {
    return await globalThis.fetch(`${base}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${tokens?.access ?? ""}` },
      signal: init.signal ?? controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

let api: AuthApi | null = null;

/** Клиент создаётся один раз и только когда авторизация включена в сборке. */
function authApi(): AuthApi | null {
  const config = useShell.getState().capabilities.auth;
  if (config === undefined) return null;
  api ??= createAuthApi(config);
  return api;
}

/** Сброс между тестами: модульное состояние иначе переезжает из теста в тест. */
export function resetSessionForTests(): void {
  tokens = null;
  renewal = null;
  api = null;
  useSession.setState({ status: "idle", account: null, failure: null, message: null });
}
