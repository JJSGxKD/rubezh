import { z } from "zod";
import { deviceSchema } from "../../diagnostics/dto/device.dto.js";

/** Запуск приложения — сколько людей открыли игру и на чём (docs/26-stage2-plan.md, WP14). */
export const sessionReportSchema = z.object({
  installId: z.string().min(8).max(64),
  build: z.string().max(64),
  contentHash: z.string().max(32),
  device: deviceSchema,
});

export type SessionReport = z.infer<typeof sessionReportSchema>;
