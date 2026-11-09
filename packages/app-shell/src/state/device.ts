import type { DeviceClass, DeviceFormFactor, DeviceOs, PlatformClientInfo, DeviceDescription } from "@bh/shared-types";

/**
 * Сведения об устройстве для статистики плейтеста: на чём играют тестеры.
 *
 * Строка user-agent на сервер не уходит — только её разбор до семейства ОС и
 * типа устройства. Модель телефона и версия браузера для статистики не нужны,
 * а без них по отчёту сложнее узнать конкретного человека.
 */
export interface DeviceEnvironment {
  userAgent: string;
  maxTouchPoints: number;
  screenWidth: number;
  screenHeight: number;
  pixelRatio: number;
  cores: number | null;
  memoryGb: number | null;
}

export function describeDevice(client: PlatformClientInfo, env: DeviceEnvironment = readEnvironment()): DeviceDescription {
  const os = osOf(env.userAgent, env.maxTouchPoints);
  return {
    clientPlatform: client.platform,
    clientVersion: client.version,
    os,
    formFactor: formFactorOf(os, env),
    screenWidth: Math.round(env.screenWidth),
    screenHeight: Math.round(env.screenHeight),
    pixelRatio: Math.round(env.pixelRatio * 100) / 100,
    cores: env.cores,
    memoryGb: env.memoryGb,
  };
}

export function osOf(userAgent: string, maxTouchPoints: number): DeviceOs {
  const ua = userAgent.toLowerCase();
  if (ua.includes("android")) return "android";
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  // iPadOS притворяется маком, но у мака нет сенсорного экрана.
  if (ua.includes("macintosh") && maxTouchPoints > 1) return "ios";
  if (ua.includes("windows")) return "windows";
  if (ua.includes("mac os") || ua.includes("macintosh")) return "macos";
  if (ua.includes("linux") || ua.includes("x11")) return "linux";
  return "other";
}

export function formFactorOf(os: DeviceOs, env: DeviceEnvironment): DeviceFormFactor {
  if (os === "windows" || os === "macos" || os === "linux") return env.maxTouchPoints > 1 ? "tablet" : "desktop";
  // Короткая сторона в CSS-пикселях отделяет телефон от планшета надёжнее
  // user-agent: Android-планшет часто не пишет о себе ничего особенного.
  const shortSide = Math.min(env.screenWidth, env.screenHeight);
  if (/ipad/.test(env.userAgent.toLowerCase()) || shortSide >= 600) return "tablet";
  return os === "other" && env.maxTouchPoints <= 1 ? "desktop" : "phone";
}

/**
 * Пороги слабого устройства. `deviceMemory` Chromium округляет до 0,25…8 ГБ, а
 * у Safari его нет вовсе; ядер на старых iPhone и дешёвых Android четыре и
 * меньше. Пороги рабочие: настоящую долю слабых покажет `deviceClass` в
 * `run_started` после выката (tasks/T-0196, вопрос 6).
 */
const LIGHT_MEMORY_GB = 2;
const LIGHT_CORES = 4;

/**
 * Класс устройства для подстройки давления (Р67): слабое получает потолок
 * врагов ниже, а недостающее добирают их здоровье и урон. Десктоп слабым не
 * бывает — его ядра и память мало говорят о кадрах; нет сведений — обычное,
 * чтобы не урезать бой зря. Определяется один раз на старте забега и нигде не
 * сохраняется: класс влияет на бой и обязан быть известен до старта.
 */
export function deviceClassOf(given?: DeviceEnvironment): DeviceClass {
  const env = given ?? readEnvironmentSafely();
  if (env === null) return "standard";
  const os = osOf(env.userAgent, env.maxTouchPoints);
  if (formFactorOf(os, env) === "desktop") return "standard";
  const weakMemory = env.memoryGb !== null && env.memoryGb <= LIGHT_MEMORY_GB;
  const weakCores = env.cores !== null && env.cores <= LIGHT_CORES;
  return weakMemory || weakCores ? "light" : "standard";
}

/** Сведения, которые не удалось прочитать (нет `screen` или `navigator`), — это «нет сведений», а не ошибка старта забега. */
function readEnvironmentSafely(): DeviceEnvironment | null {
  try {
    return readEnvironment();
  } catch {
    return null;
  }
}

export function readEnvironment(): DeviceEnvironment {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    userAgent: nav.userAgent,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    screenWidth: screen.width,
    screenHeight: screen.height,
    pixelRatio: globalThis.devicePixelRatio ?? 1,
    cores: nav.hardwareConcurrency > 0 ? nav.hardwareConcurrency : null,
    memoryGb: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
  };
}

/**
 * Подписка на смену того, что входит в сведения об устройстве: размер окна,
 * плотность пикселей и сам экран — окно перенесли на другой монитор. Сведения
 * должны пересчитываться на ходу, а не остаться снимком с момента открытия.
 * Возвращает отписку.
 */
export function watchEnvironment(onChange: () => void): () => void {
  const target = globalThis as typeof globalThis & { screen?: Screen & EventTarget };
  let density: MediaQueryList | null = null;
  const onDensity = (): void => {
    onChange();
    listenDensity();
  };
  // Запрос плотности — на текущую: сменилась — ставим новый на новое значение.
  const listenDensity = (): void => {
    density?.removeEventListener("change", onDensity);
    density = typeof matchMedia === "function" ? matchMedia(`(resolution: ${String(globalThis.devicePixelRatio ?? 1)}dppx)`) : null;
    density?.addEventListener("change", onDensity);
  };
  listenDensity();
  globalThis.addEventListener?.("resize", onChange);
  target.screen?.addEventListener?.("change", onChange);
  return () => {
    density?.removeEventListener("change", onDensity);
    globalThis.removeEventListener?.("resize", onChange);
    target.screen?.removeEventListener?.("change", onChange);
  };
}
