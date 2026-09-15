import { z } from "zod";

/**
 * Устройство разбором на клиенте (docs/28-diagnostics.md §8): семейство ОС,
 * тип, клиент площадки, экран и ядра. Строки user-agent и Telegram ID здесь
 * нет — по такому описанию конкретного человека не узнать.
 *
 * Схема общая для отчётов диагностики и статистики плейтеста: одно
 * устройство описывается одинаково, где бы оно ни встретилось.
 */
export const DEVICE_OS = ["android", "ios", "windows", "macos", "linux", "other"] as const;
export const FORM_FACTORS = ["phone", "tablet", "desktop"] as const;

export const deviceSchema = z.object({
  clientPlatform: z.string().max(32).nullable(),
  clientVersion: z.string().max(32).nullable(),
  os: z.enum(DEVICE_OS),
  formFactor: z.enum(FORM_FACTORS),
  screenWidth: z.number().int().min(0).max(10_000),
  screenHeight: z.number().int().min(0).max(10_000),
  pixelRatio: z.number().min(0).max(10),
  cores: z.number().int().min(0).max(256).nullable(),
  memoryGb: z.number().min(0).max(1024).nullable(),
});

export type StoredDevice = z.infer<typeof deviceSchema>;
