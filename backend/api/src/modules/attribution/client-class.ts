/**
 * Какой клиент открыл игру (docs/34-stage3-plan.md, WP6, п. 4): класс
 * устройства и ОС для разрезов — удержания, производительности, рекламного
 * таргетинга (docs/13-reuse-from-vpnsibcom.md §6).
 *
 * Основа — `tgWebAppPlatform`, который клиент Telegram сам передаёт Mini App,
 * а User-Agent лишь уточняет ОС там, где платформа её не называет: у
 * Telegram Desktop и веб-версий. Цепочка `includes()` по строке UA из
 * источника переноса ломалась на каждом новом клиенте.
 *
 * **Всё это подсказка клиента, а не факт.** Ни подписи, ни проверки у неё
 * нет, и для решений с денежным эффектом она не годится — только для
 * разрезов.
 */

export const DEVICE_CLASSES = ["mobile", "desktop", "web", "unknown"] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

export type OperatingSystem = "android" | "ios" | "windows" | "macos" | "linux" | "unknown";

export interface ClientHint {
  /** `tgWebAppPlatform`: android, ios, tdesktop, macos, weba, webk, unigram… */
  platform: string | null;
  /** `tgWebAppVersion` — версия Bot API, которую понимает клиент */
  version: string | null;
}

export interface ClientClass {
  deviceClass: DeviceClass;
  os: OperatingSystem;
  /** платформа клиента, приведённая к безопасному виду; `null` — не передана или мусор */
  clientPlatform: string | null;
  clientVersion: string | null;
}

const PLATFORM = /^[a-z_]{1,16}$/;
const VERSION = /^\d{1,2}(\.\d{1,2}){0,2}$/;

/** Что платформа Telegram говорит о себе сама. `os: null` — узнавать по User-Agent. */
const KNOWN_PLATFORMS: Record<string, { deviceClass: DeviceClass; os: OperatingSystem | null }> = {
  android: { deviceClass: "mobile", os: "android" },
  android_x: { deviceClass: "mobile", os: "android" },
  ios: { deviceClass: "mobile", os: "ios" },
  macos: { deviceClass: "desktop", os: "macos" },
  tdesktop: { deviceClass: "desktop", os: null },
  unigram: { deviceClass: "desktop", os: "windows" },
  weba: { deviceClass: "web", os: null },
  webk: { deviceClass: "web", os: null },
  web: { deviceClass: "web", os: null },
};

export function classifyClient(hint: ClientHint | null, userAgent: string | null): ClientClass {
  const platform = hint?.platform?.toLowerCase() ?? null;
  const clientPlatform = platform !== null && PLATFORM.test(platform) ? platform : null;
  const clientVersion = hint?.version !== null && hint?.version !== undefined && VERSION.test(hint.version) ? hint.version : null;
  const known = clientPlatform === null ? undefined : KNOWN_PLATFORMS[clientPlatform];
  const uaOs = osFromUserAgent(userAgent);

  if (known !== undefined) return { deviceClass: known.deviceClass, os: known.os ?? uaOs, clientPlatform, clientVersion };
  // Без платформы клиента — браузер или неизвестный клиент: мобильным
  // признаём только то, что так и называется.
  const deviceClass: DeviceClass = uaOs === "android" || uaOs === "ios" ? "mobile" : "unknown";
  return { deviceClass, os: uaOs, clientPlatform, clientVersion };
}

function osFromUserAgent(userAgent: string | null): OperatingSystem {
  if (userAgent === null) return "unknown";
  // Порядок важен: у Android в строке есть «Linux», у iPad на iPadOS — «Mac OS X».
  if (/android/i.test(userAgent)) return "android";
  if (/iphone|ipad|ipod/i.test(userAgent)) return "ios";
  if (/windows/i.test(userAgent)) return "windows";
  if (/mac os x|macintosh/i.test(userAgent)) return "macos";
  if (/linux|x11/i.test(userAgent)) return "linux";
  return "unknown";
}
