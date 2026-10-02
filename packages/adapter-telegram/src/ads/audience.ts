import type { AdNetworkSetup } from "@bh/shared-types";
import { TADDY_SCRIPT, ensureScript, type AdGlobals, type NetworkEnv } from "./networks";
import { browserScriptLoader, type ScriptLoader } from "./script-loader";

/**
 * SDK сетей для учёта аудитории (docs/35-stage4-plan.md WP12, часть 9, Р78):
 * сеть видит игрока, только когда у него поднят её SDK, а от числа игроков
 * зависит, сколько рекламы она даст. Какие сети и с какими ключами — решает
 * сервер; оболочка зовёт это в простое после первого кадра главной.
 *
 * Чужой скрипт игре не мешает: он асинхронный, его отказ — строка в отчёте,
 * а не ошибка, и ждать его никто не ждёт.
 */

/** Сколько ждём `init` и `ready` чужого SDK: дольше — сеть недоступна, учёт пропущен до следующего запуска. */
export const AUDIENCE_TIMEOUT_MS = 10_000;

export type AudienceResult = { network: string; ok: true } | { network: string; ok: false; reason: "unsupported" | "misconfigured" | "load_failed" | "sdk_error" | "timeout" };

type Prepare = (setup: AdNetworkSetup, env: NetworkEnv) => Promise<AudienceResult>;

async function withTimeout(task: Promise<void>, ms: number): Promise<"done" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([task.then(() => "done" as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Taddy: скрипт с `pubId` в `data-pub-id` — так SDK поднимается сам, как в
 * `vpnsibcom_web`; не поднялся — `init` руками. Затем `ready`: по нему SDK
 * шлёт Taddy `events/start` с параметром запуска — это и есть учёт игрока.
 * Оба шага — один раз за запуск: SDK помнит их сам (`isInit`, `isReady`).
 */
function prepareTaddy(timeoutMs: number): Prepare {
  return async (setup, env) => {
    const pubId = setup.keys["pubId"] ?? "";
    if (pubId === "") return { network: setup.network, ok: false, reason: "misconfigured" };
    if (!(await ensureScript(env, () => env.globals().Taddy !== undefined, TADDY_SCRIPT, { "data-pub-id": pubId }))) {
      return { network: setup.network, ok: false, reason: "load_failed" };
    }
    const sdk = env.globals().Taddy;
    if (sdk === undefined) return { network: setup.network, ok: false, reason: "load_failed" };
    try {
      if (sdk.isInit !== true && sdk.init !== undefined && (await withTimeout(sdk.init(pubId), timeoutMs)) === "timeout") {
        return { network: setup.network, ok: false, reason: "timeout" };
      }
      if (sdk.isReady !== true && sdk.ready !== undefined && (await withTimeout(sdk.ready(), timeoutMs)) === "timeout") {
        return { network: setup.network, ok: false, reason: "timeout" };
      }
    } catch {
      // SDK отказал — игроку от этого ни холодно ни жарко, причина уходит в отчёт.
      return { network: setup.network, ok: false, reason: "sdk_error" };
    }
    return { network: setup.network, ok: true };
  };
}

export interface AudienceOptions {
  globals: () => AdGlobals;
  loader: ScriptLoader;
  timeoutMs?: number;
}

/** Поднять SDK сетей учёта; сеть, которую адаптер не знает, — `unsupported`. */
export function createAudience(options: AudienceOptions): (setups: readonly AdNetworkSetup[]) => Promise<AudienceResult[]> {
  const timeoutMs = options.timeoutMs ?? AUDIENCE_TIMEOUT_MS;
  const networks: Readonly<Record<string, Prepare>> = { taddy: prepareTaddy(timeoutMs) };
  const env: NetworkEnv = { globals: options.globals, loader: options.loader, debug: false, now: Date.now };
  return async (setups) =>
    await Promise.all(
      setups.map(async (setup): Promise<AudienceResult> => {
        const prepare = networks[setup.network];
        return prepare === undefined ? { network: setup.network, ok: false, reason: "unsupported" } : await prepare(setup, env);
      }),
    );
}

let browserAudience: ((setups: readonly AdNetworkSetup[]) => Promise<AudienceResult[]>) | null = null;

/**
 * В настоящем окне — тем же загрузчиком, что показ: скрипт сети не
 * вставляется дважды. Отказ — строка в консоли: в отчёт об ошибках он не
 * идёт, у половины десктопов рекламу режет блокировщик.
 */
export async function prepareInBrowser(setups: readonly AdNetworkSetup[]): Promise<void> {
  browserAudience ??= createAudience({
    // Объекты SDK — свойства `window`, которых нет в его типах: окно читается как набор необязательных полей.
    globals: () => globalThis as unknown as AdGlobals,
    loader: browserScriptLoader(),
  });
  for (const result of await browserAudience(setups)) {
    if (!result.ok) console.warn(`SDK сети ${result.network} не поднялся: ${result.reason}`);
  }
}
