import type { PlatformClientInfo, SafeAreaInsets, ScreenMode } from "@bh/shared-types";
import { describeDevice, type DeviceEnvironment } from "./device";

/**
 * «Сведения об устройстве» для баг-репорта (docs/28-diagnostics.md §2.2).
 * Тестер копирует их одной кнопкой и присылает вместе с описанием бага.
 *
 * В отличие от статистики плейтеста (`device.ts`), здесь есть модель
 * устройства из user-agent: текст уходит команде руками тестера, а не на
 * сервер, и без модели баг «на моём телефоне» не с чем сопоставить.
 */
export interface DeviceReportInput {
  build: string;
  contentHash: string;
  installId: string;
  client: PlatformClientInfo;
  env: DeviceEnvironment;
  viewport: { width: number; height: number };
  insets: SafeAreaInsets;
  screenMode: ScreenMode;
  /** оценка частоты экрана; `null` — ещё меряется или не удалось */
  displayHz: number | null;
}

export interface DeviceReportRow {
  /** ключ перевода подписи — `diagnostics.report.<key>` */
  key: string;
  value: string;
}

export function buildDeviceReport(input: DeviceReportInput): DeviceReportRow[] {
  const device = describeDevice(input.client, input.env);
  // Для канвы — плотность без округления: 2.625 и 2.63 на ширине в тысячу
  // пикселей расходятся на целые пиксели.
  const dpr = input.env.pixelRatio;
  const rows: DeviceReportRow[] = [
    { key: "build", value: input.build },
    { key: "content", value: input.contentHash },
    { key: "install", value: input.installId },
    { key: "client", value: [input.client.platform, input.client.version].filter((part) => part !== null).join(" ") || "—" },
    { key: "model", value: deviceModel(input.env.userAgent) ?? "—" },
    { key: "os", value: `${device.os}, ${device.formFactor}` },
    { key: "screen", value: `${device.screenWidth}×${device.screenHeight}` },
    { key: "pixelRatio", value: String(device.pixelRatio) },
    { key: "viewport", value: `${Math.round(input.viewport.width)}×${Math.round(input.viewport.height)}` },
    // Канва забега создаётся в физических пикселях вьюпорта: столько
    // устройство и рисует каждый кадр.
    { key: "canvas", value: `${Math.round(input.viewport.width * dpr)}×${Math.round(input.viewport.height * dpr)}` },
    { key: "displayHz", value: input.displayHz === null ? "—" : `≈${input.displayHz}` },
    { key: "cores", value: device.cores === null ? "—" : String(device.cores) },
    { key: "memory", value: device.memoryGb === null ? "—" : String(device.memoryGb) },
    { key: "screenMode", value: input.screenMode },
    {
      key: "insets",
      value: `${input.insets.top} / ${input.insets.right} / ${input.insets.bottom} / ${input.insets.left}`,
    },
  ];
  return rows;
}

/** Текст для буфера обмена: подписи на русском, по строке на поле. */
export function formatDeviceReport(rows: readonly DeviceReportRow[], label: (key: string) => string): string {
  return rows.map((row) => `${label(row.key)}: ${row.value}`).join("\n");
}

/**
 * Модель и версия системы из user-agent. Разбор грубый, и это нормально: он
 * подсказывает команде, что за устройство, а не участвует в расчётах.
 *
 * Chrome на Android с урезанным user-agent пишет вместо модели «K» — модель
 * тогда честно неизвестна.
 */
export function deviceModel(userAgent: string): string | null {
  const android = /Android\s([\d.]+)(?:;\s*([^;)]+?))?(?:\sBuild\/[^;)]*)?[;)]/.exec(userAgent);
  if (android !== null) {
    const version = `Android ${android[1] ?? ""}`.trim();
    const model = android[2]?.trim();
    return model === undefined || model === "" || model === "K" || model.startsWith("wv") ? version : `${model}, ${version}`;
  }
  const apple = /(iPhone|iPad|iPod)[^)]*?OS\s([\d_]+)/.exec(userAgent);
  if (apple !== null) return `${apple[1] ?? ""}, iOS ${(apple[2] ?? "").replaceAll("_", ".")}`;
  if (/Windows NT/.test(userAgent)) return "Windows";
  if (/Mac OS X/.test(userAgent)) return "macOS";
  if (/Linux/.test(userAgent)) return "Linux";
  return null;
}

/**
 * Частота экрана по интервалам между кадрами: медиана, а не среднее, — один
 * долгий кадр на открытии экрана не должен сбивать оценку. Округление до
 * типовых частот не делаем: 90 и 144 Гц встречаются, и их надо видеть.
 */
export function estimateDisplayHz(intervalsMs: readonly number[]): number | null {
  const usable = intervalsMs.filter((interval) => interval > 2 && interval < 100).sort((a, b) => a - b);
  if (usable.length < 10) return null;
  const median = usable[Math.floor(usable.length / 2)] ?? 0;
  return median > 0 ? Math.round(1000 / median) : null;
}

const HZ_SAMPLE_FRAMES = 90;
const HZ_TIMEOUT_MS = 3000;

/** Снять интервалы кадров. В фоне кадров нет — отдаём то, что успели, по таймеру. */
export function measureDisplayHz(): Promise<number | null> {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    const intervals: number[] = [];
    let last = 0;
    let frame = 0;
    const finish = (): void => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      resolve(estimateDisplayHz(intervals));
    };
    const timer = setTimeout(finish, HZ_TIMEOUT_MS);
    const step = (time: number): void => {
      if (last > 0) intervals.push(time - last);
      last = time;
      if (intervals.length >= HZ_SAMPLE_FRAMES) finish();
      else frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  });
}
