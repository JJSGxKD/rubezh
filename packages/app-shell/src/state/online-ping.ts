import { z } from "zod/mini";
import type { ApiRequest } from "./api-request";
import { useNavigation } from "./navigation";
import { NO_ONLINE_NUMBERS, useOnline } from "./online";
import { usePlatform } from "./platform";

/**
 * Пинг счётчика онлайна (Р107, tasks/T-0148). Служебный запрос: он же держит
 * игрока в онлайне и сообщает, что он в забеге. Раз в `nextPingSec` из ответа,
 * только пока приложение видимо, и не нужен, если за промежуток игрок и так что-то
 * спросил у API (любой запрос сервер засчитывает как активность). В забеге —
 * всегда: флаг «в забеге» на сервере живёт недолго и без пинга погас бы
 * посреди боя.
 *
 * Счётчик — сведения, а не функция: нет сети, битый ответ, сервер без модуля —
 * плашки просто нет, и ошибка игроку не показывается. Один сбой числа не
 * убирает (прежние остаются до следующего пинга), три подряд — убирают.
 *
 * Модуль подгружается отдельным чанком после входа игрока.
 */

const PING_PATH = "/api/v1/online/ping";

/** Сколько сбоев подряд убирают плашку. */
export const ONLINE_FAILURES_TO_HIDE = 3;

/**
 * Интервал приходит с сервера (`online.ping-sec`), но клиент ему не верит
 * вслепую: сервер новее или ошибся — пинговать каждую секунду он не начнёт, а
 * раз в час игрок успел бы выпасть из онлайна. Границы совпадают с
 * каталогом настроек сервера.
 */
export const ONLINE_PING_MIN_SEC = 15;
export const ONLINE_PING_MAX_SEC = 300;
/** До первого ответа и после сбоя — умолчание сервера. */
export const ONLINE_PING_DEFAULT_SEC = 45;

const count = z.nullable(z.int().check(z.nonnegative()));

const pingSchema = z.object({
  online: count,
  inRun: count,
  todayPlayed: count,
  nextPingSec: z.number().check(z.nonnegative()),
});

type PingAnswer = z.infer<typeof pingSchema>;

/** Всё, что пингеру нужно от мира: подменяется в тестах. */
export interface OnlineEnv {
  request: ApiRequest;
  now(): number;
  /** приложение на виду: вкладка не скрыта и площадка считает его активным */
  visible(): boolean;
  inRun(): boolean;
  /** когда ушёл последний запрос к API, мс */
  lastApiAt(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface OnlinePinger {
  start(): void;
  stop(): void;
  /** Приложение снова на виду: если срок пинга вышел, пока оно спало, — пинг сразу. */
  wake(): void;
}

export function createOnlinePinger(env: OnlineEnv, store: typeof useOnline = useOnline): OnlinePinger {
  let running = false;
  let inflight = false;
  let timer: unknown = null;
  let intervalMs = ONLINE_PING_DEFAULT_SEC * 1_000;
  let lastPingAt: number | null = null;
  /** последний запрос к API, который уже учтён: свой пинг или пропущенный срок */
  let seenApiAt = 0;

  const clearScheduled = (): void => {
    if (timer !== null) env.clearTimer(timer);
    timer = null;
  };

  const schedule = (): void => {
    clearScheduled();
    timer = env.setTimer(() => {
      timer = null;
      void step();
    }, intervalMs);
  };

  const fail = (): void => {
    const failures = store.getState().failures + 1;
    store.setState(failures >= ONLINE_FAILURES_TO_HIDE ? { ...NO_ONLINE_NUMBERS, failures } : { failures });
  };

  const accept = (answer: PingAnswer): void => {
    store.setState({ online: answer.online, inRun: answer.inRun, todayPlayed: answer.todayPlayed, failures: 0 });
    const sec = Math.min(ONLINE_PING_MAX_SEC, Math.max(ONLINE_PING_MIN_SEC, answer.nextPingSec));
    intervalMs = sec * 1_000;
  };

  const ping = async (inRun: boolean): Promise<void> => {
    if (inflight) return;
    inflight = true;
    lastPingAt = env.now();
    try {
      const result = await env.request(PING_PATH, pingSchema, { method: "POST", body: { inRun } });
      if (!running) return;
      if (result.ok) accept(result.data);
      else fail();
    } catch {
      // Запрос не бросает; ловим на случай подмены в тесте или будущей правки.
      if (running) fail();
    } finally {
      inflight = false;
    }
    if (!running) return;
    // Свой пинг тоже запрос к API: он не должен считаться «чужим» на следующем сроке.
    seenApiAt = env.lastApiAt();
    schedule();
  };

  const step = async (): Promise<void> => {
    if (!running || inflight) return;
    // Скрытому приложению пинговать незачем; проснётся — `wake` решит.
    if (!env.visible()) return;
    const inRun = env.inRun();
    if (!inRun && lastPingAt !== null && env.lastApiAt() > seenApiAt) {
      seenApiAt = env.lastApiAt();
      schedule();
      return;
    }
    await ping(inRun);
  };

  return {
    start() {
      if (running) return;
      running = true;
      seenApiAt = env.lastApiAt();
      void step();
    },
    stop() {
      running = false;
      clearScheduled();
    },
    wake() {
      if (!running || inflight || !env.visible()) return;
      if (lastPingAt !== null && env.now() - lastPingAt < intervalMs) return;
      clearScheduled();
      void step();
    },
  };
}

/** Видимость: вкладка не скрыта, а площадка не свернула приложение. */
function appVisible(): boolean {
  const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  return !hidden && usePlatform.getState().isActive;
}

/**
 * Запустить пинг на реальном окружении. Вызывается один раз после входа
 * игрока; возвращает остановку. Гостю без входа пинговать некому — этот
 * вызов для него не делается.
 */
export async function startOnlinePing(): Promise<() => void> {
  // Клиент API — отдельным чанком: плашке и «Играть» нужны только числа, а за
  // ними в первую загрузку тянулся бы весь запросчик.
  const { apiRequest, lastApiRequestAt } = await import("./api-request");
  const pinger = createOnlinePinger({
    request: apiRequest,
    now: () => Date.now(),
    visible: appVisible,
    // Забег — экран «run» в стеке; настройки поверх паузы забега его не убирают.
    inRun: () => useNavigation.getState().stack.includes("run"),
    lastApiAt: lastApiRequestAt,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
  const wake = (): void => pinger.wake();
  document.addEventListener("visibilitychange", wake);
  const stopActive = usePlatform.subscribe((state, previous) => {
    if (state.isActive && !previous.isActive) wake();
  });
  pinger.start();
  return () => {
    document.removeEventListener("visibilitychange", wake);
    stopActive();
    pinger.stop();
  };
}
