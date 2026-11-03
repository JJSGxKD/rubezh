import { z } from "zod";
import { DEFAULT_SEEDS, MAX_SCENARIOS, MAX_SEEDS } from "./limits";

// Сообщения схемы — русские: их читает команда в панели, а не разработчик.
z.config(z.locales.ru());

/**
 * Сценарий симуляции: бот, стартовое оружие, сложность и уровень аккаунта.
 * Те же параметры, что у `simulateBalanceRun`; не заданное — как в свод калибровки.
 */
export const scenarioSpecSchema = z.strictObject({
  id: z.string().min(1).max(80),
  skill: z.enum(["passive", "dodging"]),
  startingWeaponId: z.string().min(1).max(64).optional(),
  difficultyId: z.string().min(1).max(32).optional(),
  accountLevel: z.number().int().min(1).max(1_000).optional(),
  seeds: z.number().int().min(1).max(MAX_SEEDS).optional(),
});

export type ScenarioSpec = z.infer<typeof scenarioSpecSchema>;

/**
 * Задание очереди `content-check`. Идентификатор — и идентификатор задания в
 * BullMQ, а он не терпит двоеточия. Снимки — `unknown`: их форму проверяет
 * схема снимка и называет проблемы с путями, а не падение задания.
 */
export const CHECK_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const checkJobSchema = z.strictObject({
  checkId: z.string().regex(CHECK_ID),
  snapshot: z.unknown(),
  baseSnapshot: z.unknown(),
  /** пусто — набор по умолчанию, как в своде калибровки */
  scenarios: z.array(scenarioSpecSchema).max(MAX_SCENARIOS).default([]),
  /** зёрен по умолчанию у сценариев без своих; не задано — двадцать */
  seeds: z.number().int().min(1).max(MAX_SEEDS).default(DEFAULT_SEEDS),
});

export type CheckJob = z.output<typeof checkJobSchema>;
/** То, что ставит в очередь производитель: умолчания дозаполнит воркер. */
export type CheckJobInput = z.input<typeof checkJobSchema>;

/** Размер снимка так, как он лежит в Redis: JSON в UTF-8. */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}
