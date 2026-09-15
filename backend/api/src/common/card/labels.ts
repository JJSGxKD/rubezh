/**
 * Подписи в карточках для команды: устройство, клиент площадки, исход
 * стресс-теста, длительность. Карточки администраторов — по-русски: их читает
 * команда, а не игроки.
 */

const OS_LABELS: Record<string, string> = {
  android: "Android",
  ios: "iOS",
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  other: "Другая",
};

const FORM_FACTOR_LABELS: Record<string, string> = { phone: "Телефон", tablet: "Планшет", desktop: "Компьютер" };

/** Клиенты площадки по `tgWebAppPlatform`; неизвестный показывается как есть. */
const CLIENT_LABELS: Record<string, string> = {
  android: "TG Android",
  android_x: "TG Android X",
  ios: "TG iOS",
  tdesktop: "TG Desktop",
  macos: "TG macOS",
  weba: "TG Web A",
  webk: "TG Web K",
  web: "TG Web",
  max: "MAX",
  vk: "VK",
  unknown: "Вне площадки",
};

/** Чем закончился прогон стресс-теста — `BenchStopReason` движка. */
const STRESS_OUTCOME_LABELS: Record<string, string> = {
  degradation: "предел найден",
  duration: "предел не найден",
  pool_exhausted: "упёрлись в стенд",
  manual: "остановлен",
};

export function stressOutcomeLabel(outcome: string): string {
  return STRESS_OUTCOME_LABELS[outcome] ?? outcome;
}

export function osLabel(os: string): string {
  return OS_LABELS[os] ?? os;
}

export function formFactorLabel(formFactor: string): string {
  return FORM_FACTOR_LABELS[formFactor] ?? formFactor;
}

export function clientLabel(client: string): string {
  return CLIENT_LABELS[client] ?? client;
}

/** «4:05», «1:02:40» — как таймер забега в клиенте. */
export function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = String(sec % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** Русская форма числительного: «1 забег», «3 забега», «11 забегов». */
export function pluralRu(count: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(count) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}
