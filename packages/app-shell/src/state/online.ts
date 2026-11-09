import type { ButtonBar } from "@bh/shared-types";
import { create } from "zustand";
import { z } from "zod/mini";
import { formatDecimal, t } from "../i18n";
import { apiRequest, lastApiRequestAt, type ApiRequest } from "./api-request";
import { useNavigation } from "./navigation";
import { usePlatform } from "./platform";

/**
 * Счётчик онлайна (Р107, docs/35-stage4-plan.md; tasks/T-0148): сколько людей
 * сейчас в игре и в забеге. Числа считает сервер и сам же применяет пороги:
 * ниже порога поле ответа — `null`, клиент ничего не решает и не достраивает.
 *
 * Счётчик — сведения, а не функция: нет сети, битый ответ, сервер без модуля —
 * плашки просто нет, и ошибка игроку не показывается. Один сбой числа не
 * убирает (прежние остаются до следующего пинга), три подряд — убирают.
 *
 * Пинг — служебный запрос: он же держит игрока в онлайне и сообщает, что он в
 * забеге. Раз в `nextPingSec` из ответа, только пока приложение видимо, и не
 * нужен, если за промежуток игрок и так что-то спросил у API (любой запрос
 * сервер засчитывает как активность). В забеге — всегда: флаг «в забеге» на
 * сервере живёт недолго и без пинга погас бы посреди боя.
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

/** Числа плашки: то, что сервер отдал в последний удачный раз. */
export interface OnlineNumbers {
  online: number | null;
  inRun: number | null;
  todayPlayed: number | null;
}

export interface OnlineStore extends OnlineNumbers {
  /** сбоев подряд; удача обнуляет */
  failures: number;
}

const NO_NUMBERS: OnlineStore = { online: null, inRun: null, todayPlayed: null, failures: 0 };

export const useOnline = create<OnlineStore>()(() => NO_NUMBERS);

/** Сброс между тестами: хранилище модульное. */
export function resetOnlineForTests(): void {
  useOnline.setState(NO_NUMBERS);
}

export type OnlineView = { kind: "now"; count: number } | { kind: "today"; count: number };

/**
 * Что показать на плашке. «Сейчас» — когда сервер дал онлайн; иначе «сегодня
 * играли», если оно есть; чисел нет — `null` (плашки нет, без заглушки «—»).
 * Ноль приравнен к отсутствию: «0 онлайн» выглядит как поломка, а не как сведения.
 */
export function onlineView(numbers: OnlineNumbers): OnlineView | null {
  if (numbers.online !== null && numbers.online > 0) return { kind: "now", count: numbers.online };
  if (numbers.todayPlayed !== null && numbers.todayPlayed > 0) return { kind: "today", count: numbers.todayPlayed };
  return null;
}

/** Подпись «N в забеге» под «Играть»; `null` — подписи нет. */
export function runCaption(numbers: Pick<OnlineNumbers, "inRun">): number | null {
  return numbers.inRun !== null && numbers.inRun > 0 ? numbers.inRun : null;
}

/**
 * Число для плашки: до тысячи как есть, дальше — «1,2 тыс.» до десяти тысяч и
 * «12 тыс.» после. Округление вниз: плашка не должна показывать больше, чем
 * есть. Своё, а не `formatCompact`: тот пишет «12,3К» и целые тысячи до десяти
 * тысяч, а плашка стоит в полосе кнопок, где место на счету.
 */
export function formatOnlineCount(value: number): string {
  const whole = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  if (whole < 1_000) return String(whole);
  const decimals = whole < 10_000 ? 1 : 0;
  const unit = 10 ** (3 - decimals);
  return t("online.thousands", { value: formatDecimal(Math.floor(whole / unit) / 10 ** decimals, decimals) });
}

export type OnlinePlacement = "bar" | "subline" | "header";

/**
 * Где стоит плашка. На ПК — в широкой шапке, сколько бы места ни было по
 * бокам; иначе в полосе кнопок площадки, если она есть (место, которое иначе
 * пустует), а без неё — строкой под шапкой.
 */
export function onlinePlacement(input: { wide: boolean; bar: ButtonBar | null }): OnlinePlacement {
  if (input.wide) return "header";
  return input.bar === null ? "subline" : "bar";
}

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
    store.setState(failures >= ONLINE_FAILURES_TO_HIDE ? { ...NO_NUMBERS, failures } : { failures });
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
export function startOnlinePing(): () => void {
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
