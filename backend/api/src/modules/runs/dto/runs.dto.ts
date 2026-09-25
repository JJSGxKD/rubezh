import { z } from "zod";
import { DIFFICULTIES } from "../run-rules.js";

/**
 * Тела запросов забегов (docs/34-stage3-plan.md, WP4). Границы здесь — форма
 * правдоподобия, а не антифрод: забег длиннее суток или отрицательный уровень
 * — это битые данные. Проверка по существу — в `run-verdict.ts`.
 */

const runId = z.string().min(8).max(64);
const weaponId = z.string().min(1).max(64);

/** Сообщение о старте: уходит в начале забега, в очередь, не на горячем пути. */
export const runStartSchema = z.object({
  runId,
  difficultyId: z.enum(DIFFICULTIES),
  startingWeaponId: weaponId,
  contentHash: z.string().max(32),
  // Сколько секунд забега прошло к отправке: сообщение могло пролежать в
  // очереди без сети. Сервер вычитает это из своего времени приёма
  // (run-verdict.ts, trustedStartMs).
  elapsedSec: z.number().min(0).max(86_400).default(0),
});

/**
 * Сколько вторых шансов вообще может прийти в итоге: потолок движка
 * (`MAX_CONTINUES_PER_RUN`), а не правило игры — сколько продаётся, решает
 * сверка с покупками.
 */
const MAX_CONTINUES = 5;

/** Итог забега. */
export const runFinishSchema = z
  .object({
    runId,
    difficultyId: z.enum(DIFFICULTIES),
    outcome: z.enum(["died", "abandoned"]),
    survivalSec: z.number().min(0).max(86_400),
    level: z.number().int().min(1).max(999),
    enemiesKilled: z.number().int().min(0).max(1_000_000),
    startingWeaponId: weaponId,
    // Потолок формы, а не правило игры: сколько слотов под оружие, решает
    // вердикт, и забег с лишним оружием должен дойти до него, а не упасть
    // здесь безымянной ошибкой разбора.
    weapons: z.array(z.object({ id: weaponId, level: z.number().int().min(1).max(99) })).max(16),
    contentHash: z.string().max(32),
    deathCause: z.string().min(1).max(64).nullable().default(null),
    cheats: z.boolean().default(false),
    countInRating: z.boolean().default(false),
    // Секунда каждого второго шанса (docs/07-monetization-and-ads.md §8).
    // Сборки до второго шанса поля не шлют — это забег без продолжений.
    continues: z.array(z.number().min(0).max(86_400)).max(MAX_CONTINUES).default([]),
  })
  // Продолжение позже конца забега или раньше предыдущего — не забег, а
  // битые данные: честный клиент берёт секунды из одного мира.
  .refine((run) => run.continues.every((sec, index) => sec <= run.survivalSec && sec >= (run.continues[index - 1] ?? 0)), {
    message: "секунды продолжений вне забега",
    path: ["continues"],
  });

export const difficultyQuerySchema = z.enum(DIFFICULTIES);
export const reviewLimitSchema = z.coerce.number().int().min(1).max(200).default(50);

export type RunStart = z.infer<typeof runStartSchema>;
export type RunFinish = z.infer<typeof runFinishSchema>;
