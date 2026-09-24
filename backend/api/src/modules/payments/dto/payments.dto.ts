import { z } from "zod";

/**
 * Тела запросов оплаты (docs/34-stage3-plan.md, WP5). **Цены в запросе нет
 * ни в каком виде** (Р5.1): клиент сообщает, какой забег и на какой секунде
 * он хочет продолжить, а сколько это стоит, считает сервер.
 */

export const continueRequestSchema = z.object({
  runId: z.string().min(8).max(64),
  /** какое по счёту продолжение забега, с единицы: ключ идемпотентности счёта вместе с `runId` */
  continueNo: z.number().int().min(1).max(5),
  /** секунда забега, на которой игрок умер: по ней считается цена */
  elapsedSec: z.number().min(0).max(86_400),
});

export const purchaseIdSchema = z.uuid();

export type ContinueRequest = z.infer<typeof continueRequestSchema>;
