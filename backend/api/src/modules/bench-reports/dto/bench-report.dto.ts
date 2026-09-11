import { z } from "zod";

/**
 * Схема отчёта FPS-испытания. Данные приходят с границы системы — с телефона,
 * через публичный туннель — и потому парсятся, а не приводятся через `as`
 * (CLAUDE.md, «Стиль кода»).
 *
 * Схема сознательно нестрогая к незнакомым полям верхнего уровня отчёта:
 * версия схемы отчёта живёт в клиенте, а клиент обновляется отдельно от
 * сервера. Обязательным считается только то, без чего отчёт бессмыслен.
 */
const frameStatsSchema = z.object({
  frames: z.number().int().nonnegative(),
  durationSec: z.number().nonnegative(),
  avgFps: z.number().nonnegative(),
  minFps: z.number().nonnegative(),
  p50FrameMs: z.number().nonnegative(),
  p95FrameMs: z.number().nonnegative(),
  p99FrameMs: z.number().nonnegative(),
  over33Ratio: z.number().min(0).max(1),
});

const profileSchema = z.object({
  mode: z.enum(["ramp", "fixed", "stress"]),
  targetPopulation: z.number().int().nonnegative(),
  addPerSecond: z.number().nonnegative().nullable(),
  seed: z.number().int(),
  durationSec: z.number().nonnegative(),
  buildVersion: z.string().max(64),
  canvasWidth: z.number().nonnegative(),
  canvasHeight: z.number().nonnegative(),
  devicePixelRatio: z.number().positive(),
  renderer: z.string().max(32),
});

const deviceSchema = z.object({
  userAgent: z.string().max(512),
  platform: z.string().max(128),
  hardwareConcurrency: z.number().int().nonnegative(),
  deviceMemoryGb: z.number().nonnegative().nullable(),
  screenWidth: z.number().nonnegative(),
  screenHeight: z.number().nonnegative(),
  devicePixelRatio: z.number().positive(),
  telegramPlatform: z.string().max(64).nullable(),
  telegramVersion: z.string().max(32).nullable(),
  telegramUserId: z.string().max(64).nullable(),
  telegramLanguage: z.string().max(16).nullable(),
  telegramIsPremium: z.boolean().nullable(),
  telegramFullscreen: z.boolean().nullable(),
});

const verdictSchema = z.object({
  level: z.enum(["go", "no-go", "invalid"]),
  sustainedLoad: z.number().nonnegative(),
  breakingPoint: z
    .object({
      atSec: z.number().nonnegative(),
      load: z.number().nonnegative(),
      avgFps: z.number().nonnegative(),
      p95FrameMs: z.number().nonnegative(),
    })
    .nullable(),
  failures: z.array(z.string().max(512)).max(32),
});

export const submitBenchReportSchema = z.object({
  /**
   * Ключ идемпотентности. Генерируется на устройстве один раз на прогон:
   * стенд отправляет отчёт автоматически, и у человека есть кнопка «отправить
   * ещё раз» — без ключа повторные нажатия наплодили бы дубликаты.
   *
   * Хэш тела в этой роли не годится: два прогона на одном устройстве с одним
   * seed могут совпасть до байта (docs/13-reuse-from-vpnsibcom.md §2.2).
   */
  reportId: z.string().uuid(),
  report: z.object({
    schema: z.string().max(64),
    startedAt: z.string().datetime(),
    stoppedBy: z.enum(["duration", "degradation", "pool_exhausted", "manual"]).optional(),
    interruptions: z.number().int().nonnegative().optional(),
    profile: profileSchema,
    device: deviceSchema,
    totals: frameStatsSchema.extend({
      over20Ratio: z.number().min(0).max(1),
      degradationRatio: z.number().min(0),
      peakLoad: z.number().nonnegative(),
      // Поля схемы v3. Необязательные: клиент обновляется отдельно от сервера
      // (ревью-лаг площадок, docs/09-ci-cd.md §4), и отчёт со старого билда
      // должен приниматься, а не отклоняться.
      peakProjectiles: z.number().nonnegative().optional(),
      peakObjects: z.number().nonnegative().optional(),
      displayHz: z.number().nonnegative().optional(),
    }),
    windows: z
      .array(
        frameStatsSchema.extend({
          index: z.number().int(),
          startSec: z.number(),
          avgLoad: z.number(),
          maxLoad: z.number(),
          avgProjectiles: z.number().optional(),
        }),
      )
      .max(120),
    timeline: z
      .array(
        frameStatsSchema.extend({
          index: z.number().int(),
          startSec: z.number(),
          load: z.number(),
          projectiles: z.number().optional(),
        }),
      )
      .max(600),
  }),
  verdict: verdictSchema,
});

export type SubmitBenchReportDto = z.infer<typeof submitBenchReportSchema>;
