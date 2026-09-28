import { z } from "zod";
import { MAX_BOOSTS_PER_RUN } from "../boost-catalog.js";

/**
 * Граница бустов (docs/35-stage4-plan.md §3.5, Р39). Клиент называет забег и
 * бусты, а не цену: сколько списать, решает сервер по своему каталогу.
 * Ключ операции — сам забег: одна покупка на забег.
 */

const runId = z.string().min(8).max(64);

export const boostActivateSchema = z.object({
  runId,
  boosts: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(MAX_BOOSTS_PER_RUN)
    .refine((boosts) => new Set(boosts).size === boosts.length, { message: "буст повторяется" }),
});

export const boostRefundSchema = z.object({ runId });
