import { create } from "zustand";
import { track } from "./shell";

/**
 * Связь с API (tasks/T-0015): одна плашка на всё приложение вместо ошибки на
 * каждом экране. Статус выводится из исхода запросов игрока (`apiRequest`),
 * а не из `navigator.onLine`, которому в мессенджерах верить нельзя: он
 * «онлайн» и за закрытым прокси.
 *
 * - «нет связи» — два сбоя подряд в пределах окна или событие браузера
 *   `offline`; один сбой — ещё не потеря, иначе плашка мигала бы от одного
 *   медленного запроса;
 * - любой ответ сервера, даже с ошибкой, — связь есть: у экрана своя ошибка;
 * - пока связи нет, раз в период идёт проверочный запрос; «Повторить» и событие
 *   браузера `online` запускают проверку сразу.
 */

/** Окно, в которое укладываются два сбоя подряд. */
export const CONNECTION_FAILURE_WINDOW_MS = 30_000;
/** Как часто проверять связь, пока её нет. */
export const CONNECTION_PROBE_PERIOD_MS = 20_000;

export interface ConnectionState {
  status: "online" | "offline";
  /** когда пропала связь; `null`, пока она есть */
  since: number | null;
  /** когда случился первый сбой окна; сбой в окне — второй, и это уже потеря связи */
  firstFailAt: number | null;
  /** идёт проверка по кнопке или по таймеру */
  checking: boolean;
  /**
   * когда браузер последний раз сказал `offline` — и тогда, когда связи уже
   * нет: ответ на запрос, ушедший до обрыва, не говорит, что сервер жив сейчас
   */
  lastBrowserOfflineAt: number | null;
}

export type Signal =
  | { kind: "fail"; at: number }
  /** `sentAt` — когда запрос ушёл: ответ на более ранний, чем обрыв, связь не возвращает */
  | { kind: "reachable"; at: number; sentAt: number }
  | { kind: "browser_offline"; at: number }
  | { kind: "browser_online"; at: number };

export const INITIAL_CONNECTION: ConnectionState = { status: "online", since: null, firstFailAt: null, checking: false, lastBrowserOfflineAt: null };

/** Чистая функция переходов: таймеров и обращений к окну здесь нет. */
export function nextConnection(state: ConnectionState, signal: Signal): ConnectionState {
  switch (signal.kind) {
    case "reachable":
      // Запрос ушёл до обрыва, а ответ пришёл после: сервер мог ответить в последний миг до него.
      if (state.lastBrowserOfflineAt !== null && signal.sentAt <= state.lastBrowserOfflineAt) return state;
      return INITIAL_CONNECTION;
    case "browser_online":
      // Браузер считает, что сеть есть, но до сервера это ещё не дошло: решит проверка.
      return state;
    case "browser_offline":
      return state.status === "offline" ? { ...state, lastBrowserOfflineAt: signal.at } : { ...state, status: "offline", since: signal.at, lastBrowserOfflineAt: signal.at };
    case "fail": {
      if (state.status === "offline") return state;
      const inWindow = state.firstFailAt !== null && signal.at - state.firstFailAt <= CONNECTION_FAILURE_WINDOW_MS;
      return inWindow ? { ...state, status: "offline", since: signal.at } : { ...state, firstFailAt: signal.at };
    }
  }
}

export const useConnection = create<ConnectionState>(() => INITIAL_CONNECTION);

function apply(signal: Signal): void {
  const before = useConnection.getState();
  const after = nextConnection(before, signal);
  // Ответ сервера при живой связи приходит на каждый запрос: стор от него не трогаем.
  if (after.status === before.status && after.since === before.since && after.firstFailAt === before.firstFailAt && after.checking === before.checking && after.lastBrowserOfflineAt === before.lastBrowserOfflineAt) return;
  useConnection.setState(after);
  if (before.status === "online" && after.status === "offline") {
    track("connection_lost", {});
    void prober().then((module) => module.watchConnection(true));
  } else if (before.status === "offline" && after.status === "online") {
    track("connection_restored", { downtimeSec: Math.max(0, Math.round((signal.at - (before.since ?? signal.at)) / 1000)) });
    void prober().then((module) => module.watchConnection(false));
  }
}

/**
 * Исход запроса к API: `fail` — обрыв, таймаут или 502–504, `reachable` —
 * сервер ответил; `sentAt` — когда запрос ушёл (по умолчанию — сейчас).
 */
export function reportReachability(kind: "fail" | "reachable", at = Date.now(), sentAt = at): void {
  apply(kind === "fail" ? { kind, at } : { kind, at, sentAt });
}

/** Событие браузера `offline`; снаружи его зовёт только тест — окно подписано ниже. */
export function reportBrowserOffline(at = Date.now()): void {
  apply({ kind: "browser_offline", at });
}

/**
 * Проверка связи, её таймер и событие `online` живут в `api-request.ts` и
 * подгружаются, только когда связь пропала: первому кадру они не нужны, а
 * первая загрузка под бюджетом (`pnpm budget`).
 */
const prober = () => import("./api-request");

/** Проверить связь сейчас — кнопка «Повторить». */
export function retryConnection(): Promise<void> {
  return prober().then((module) => module.checkConnection());
}

/** События браузера — один раз, при первом импорте; в тестах без окна их нет. */
if (typeof window !== "undefined") window.addEventListener("offline", () => reportBrowserOffline());

export function resetConnectionForTests(): void {
  useConnection.setState({ ...INITIAL_CONNECTION });
  void prober().then((module) => module.watchConnection(false));
}
