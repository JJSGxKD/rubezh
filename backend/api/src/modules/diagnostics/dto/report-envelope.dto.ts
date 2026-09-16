import { z } from "zod";
import type { submitBenchReportSchema } from "./bench-report.dto.js";
import { deviceSchema } from "./device.dto.js";

/**
 * Общий конверт отчёта диагностики (docs/28-diagnostics.md §5.1): кто, когда и
 * на чём прислал, а `payload` — по схеме своего вида: стресс-тест (`bench`)
 * или запись забега (`run`).
 */
export const REPORT_KINDS = ["bench", "run"] as const;

export type ReportKind = (typeof REPORT_KINDS)[number];

export const reportEnvelopeSchema = z.object({
  reportId: z.uuid(),
  kind: z.enum(REPORT_KINDS),
  appVersion: z.string().min(1).max(64),
  contentHash: z.string().max(64).nullable(),
  installId: z.string().regex(/^[0-9a-zA-Z-]{8,64}$/),
  platform: z.enum(["telegram", "max", "vk", "web"]),
  occurredAt: z.iso.datetime({ offset: true }),
  device: deviceSchema,
  payload: z.unknown(),
});

export type ReportEnvelope = z.infer<typeof reportEnvelopeSchema>;

export type BenchSubmission = z.infer<typeof submitBenchReportSchema>;
