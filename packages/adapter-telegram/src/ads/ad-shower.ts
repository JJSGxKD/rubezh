import type { AdShowOutcome, AdShowRequest } from "@bh/shared-types";
import { createAdsgram, createAdsonar, createRichads, createTaddy, type AdGlobals, type NetworkEnv, type NetworkShow } from "./networks";
import { createScriptLoader, documentScriptHost, type ScriptLoader } from "./script-loader";

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
 * может завести сеть раньше, чем её обёртка доедет до игрока.
 */
export function createAdShower(options: AdShowerOptions): (request: AdShowRequest) => Promise<AdShowOutcome> {
  const networks: Readonly<Record<string, NetworkShow>> = {
    adsgram: createAdsgram(),
    adsonar: createAdsonar(),
    richads: createRichads(),
    taddy: createTaddy(),
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
      // Тестовые показы — по слову сервера: решает команда в настройках, а не сборка.
      const env: NetworkEnv = { globals: options.globals, loader: options.loader, debug: request.debug === true, now };
      return await Promise.race([show(request, env).catch((): AdShowOutcome => ({ kind: "failed", reason: "sdk_error" })), timeout]);
    } finally {
      clearTimeout(timer);
      busy = false;
    }
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
    loader: createScriptLoader(documentScriptHost(() => document)),
  });
  return browserShower(request);
}
