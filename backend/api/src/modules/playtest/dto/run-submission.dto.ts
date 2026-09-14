import { z } from "zod";
import { DIFFICULTIES } from "../playtest.store";

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
});

export type RunSubmission = z.infer<typeof runSubmissionSchema>;

export const difficultyQuerySchema = z.enum(DIFFICULTIES);
