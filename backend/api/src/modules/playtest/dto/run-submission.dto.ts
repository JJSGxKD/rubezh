import { z } from "zod";
import { DIFFICULTIES } from "../playtest.store";
import { DEVICE_OS, FORM_FACTORS } from "../playtest-stats.store";

/**
 * Итог забега от клиента. Границы — форма правдоподобия, а не антифрод:
 * забег длиннее суток или отрицательный уровень — это битые данные, а не
 * рекорд (docs/26-stage2-plan.md, WP13).
 */
export const runSubmissionSchema = z.object({
  runId: z.string().min(8).max(64),
  difficultyId: z.enum(DIFFICULTIES),
  outcome: z.enum(["died", "abandoned"]),
  survivalSec: z.number().min(0).max(86_400),
  level: z.number().int().min(1).max(999),
  enemiesKilled: z.number().int().min(0).max(1_000_000),
  startingWeaponId: z.string().min(1).max(64),
  weapons: z.array(z.object({ id: z.string().min(1).max(64), level: z.number().int().min(1).max(99) })).max(8),
  contentHash: z.string().max(32),
  // Необязательные: клиент прошлой сборки их не шлёт, а забег из его очереди
  // всё равно должен дойти.
  deathCause: z.string().min(1).max(64).nullable().default(null),
  cheats: z.boolean().default(false),
  countInRating: z.boolean().default(false),
});

export type RunSubmission = z.infer<typeof runSubmissionSchema>;

export const difficultyQuerySchema = z.enum(DIFFICULTIES);

/** Запуск приложения — сколько людей открыли игру и на чём (docs/26-stage2-plan.md, WP14). */
export const sessionReportSchema = z.object({
  installId: z.string().min(8).max(64),
  build: z.string().max(64),
  contentHash: z.string().max(32),
  device: z.object({
    clientPlatform: z.string().max(32).nullable(),
    clientVersion: z.string().max(32).nullable(),
    os: z.enum(DEVICE_OS),
    formFactor: z.enum(FORM_FACTORS),
    screenWidth: z.number().int().min(0).max(10_000),
    screenHeight: z.number().int().min(0).max(10_000),
    pixelRatio: z.number().min(0).max(10),
    cores: z.number().int().min(0).max(256).nullable(),
    memoryGb: z.number().min(0).max(1024).nullable(),
  }),
});

export type SessionReport = z.infer<typeof sessionReportSchema>;
