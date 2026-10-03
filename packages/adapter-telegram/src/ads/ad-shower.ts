import type { AdShowOutcome, AdShowRequest } from "@bh/shared-types";
import { createAdsgram, createAdsonar, createRichads, type AdGlobals, type NetworkEnv, type NetworkShow } from "./networks";
import { browserScriptLoader, type ScriptLoader } from "./script-loader";

// Учёт аудитории сетями — в том же чанке, что показ: загрузчик скриптов у них
// общий, и отдельный чанк стоил бы первой загрузке ещё одного имени в списке
// предзагрузки.
export { prepareInBrowser } from "./audience";
// Задания сетей — тот же скрипт AdsGram, что ролики, и тот же загрузчик;
// переход по заданию ленты Taddy — рядом: строка ленты стоит на том же экране.
export { mountTaskInBrowser } from "./tasks";
export { openTaskInBrowser } from "./task-links";

/**
 * Сколько ждём исхода показа. Ролик за награду длится до минуты, и игрок
 * может задержаться на нём; дольше — SDK потерял событие, и интерфейс не
 * должен навсегда застрять в «загрузке» (docs/33-telegram-mini-app-pitfalls.md §6).
 */
export const SHOW_TIMEOUT_MS = 180_000;

export interface AdShowerOptions {
  globals: () => AdGlobals;
  loader: ScriptLoader;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Показ рекламы сети по запросу сервера: сеть — по имени, два показа
 * разом невозможны (`busy`), исход — всегда, даже если SDK замолчал.
 * Сеть, которую адаптер не знает, — `unsupported`: сервер новее клиента
 * может завести сеть раньше, чем её обёртка доедет до игрока. Taddy среди них:
 * её креатив рисует оболочка, а не SDK (Р78).
 */
export function createAdShower(options: AdShowerOptions): (request: AdShowRequest) => Promise<AdShowOutcome> {
  const networks: Readonly<Record<string, NetworkShow>> = {
    adsgram: createAdsgram(),
    adsonar: createAdsonar(),
    richads: createRichads(),
  };
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? SHOW_TIMEOUT_MS;
  let busy = false;

  return async (request) => {
    const show = networks[request.network];
    if (show === undefined) return { kind: "failed", reason: "unsupported" };
    if (busy) return { kind: "failed", reason: "busy" };
    busy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<AdShowOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "failed", reason: "timeout" }), timeoutMs);
      });
      let late = false;
      const loader = request.readyWithinMs === undefined ? options.loader : loaderWithin(options.loader, request.readyWithinMs, () => (late = true));
      // Тестовые показы — по слову сервера: решает команда в настройках, а не сборка.
      const env: NetworkEnv = { globals: options.globals, loader, debug: request.debug === true, now };
      const outcome = await Promise.race([show(request, env).catch((): AdShowOutcome => ({ kind: "failed", reason: "sdk_error" })), timeout]);
      return late && outcome.kind === "failed" ? { kind: "failed", reason: "late" } : outcome;
    } finally {
      clearTimeout(timer);
      busy = false;
    }
  };
}

/**
 * Загрузчик со сроком — для показа, которого ждёт старт забега: скрипт не
 * успел — отказ, сеть говорит «не загрузился», а показ — `late`. Сама
 * загрузка не прерывается и остаётся в памяти загрузчика: следующий показ
 * получит скрипт сразу.
 */
function loaderWithin(loader: ScriptLoader, withinMs: number, onLate: () => void): ScriptLoader {
  return {
    load: (src, attributes) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          onLate();
          reject(new Error(`скрипт ${src} не успел за ${String(withinMs)} мс`));
        }, Math.max(0, withinMs));
        loader.load(src, attributes).then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      }),
  };
}

let browserShower: ((request: AdShowRequest) => Promise<AdShowOutcome>) | null = null;

/**
 * Показ в настоящем окне: SDK сетей кладут свои объекты в `window`, скрипты
 * — в `<head>`. Один на приложение: контроллеры блоков и признак «идёт
 * показ» общие у всех мест.
 */
export function showInBrowser(request: AdShowRequest): Promise<AdShowOutcome> {
  browserShower ??= createAdShower({
    // Объекты SDK — свойства `window`, которых нет в его типах: окно читается как набор необязательных полей.
    globals: () => globalThis as unknown as AdGlobals,
    loader: browserScriptLoader(),
  });
  return browserShower(request);
}
