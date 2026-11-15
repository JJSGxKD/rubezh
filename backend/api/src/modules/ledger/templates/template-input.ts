import { z } from "zod";
import { NAME_MAX } from "../ledger-chart.js";
import { NOTE_MAX } from "../operations/operation-input.js";
import { TEMPLATE_SCHEDULES } from "./schedule.js";

/**
 * Что вводит человек, заводя и правя шаблон расхода (docs/37-accounting.md §8, Р220, tasks/T-0463). Сумма — десятичной
 * строкой в валюте места, как у ручных операций; в минимальные единицы её переводит сервис. Схема строгая: лишнее
 * поле — опечатка клиента, а не повод его проигнорировать.
 */

/** Сумма без знака и экспоненты; нулевую и лишние знаки проверит сервис. */
const money = z.string().regex(/^\d{1,18}(\.\d{1,18})?$/u);
/** Идентификатор счёта места или статьи: `bank.karta`, `vps`. */
const idSchema = z.string().regex(/^[a-z0-9._-]{1,64}$/u);
const month = z.number().int().min(1).max(12);
const note = z.string().trim().max(NOTE_MAX);

export const createTemplateSchema = z.strictObject({
  name: z.string().trim().min(1).max(NAME_MAX),
  articleId: idSchema,
  placeAccountId: idSchema,
  amount: money,
  schedule: z.enum(TEMPLATE_SCHEDULES),
  month: month.optional(),
  note: note.optional(),
});

/**
 * Правка: любое подмножество полей, но не пустое. `month: null` и `note: null` — снять; остальное сервис проверяет в
 * сочетании с тем, что уже записано (смена графика и места).
 */
export const updateTemplateSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(NAME_MAX).optional(),
    articleId: idSchema.optional(),
    placeAccountId: idSchema.optional(),
    amount: money.optional(),
    schedule: z.enum(TEMPLATE_SCHEDULES).optional(),
    month: month.nullable().optional(),
    note: note.nullable().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined));

/** Период «Расходов месяца»: «ГГГГ-ММ»; окно допустимых периодов проверяет сервис. */
export const draftPeriodSchema = z.strictObject({ period: z.string() });

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
