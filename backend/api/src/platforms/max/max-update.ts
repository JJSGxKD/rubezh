import { z } from "zod";

/**
 * События бота MAX, которые читает сервер (docs/35-stage4-plan.md Р188,
 * tasks/T-0379). Подписка ставится только на `bot_started`: бот отвечает на
 * старт со ссылки с кодом и больше ни на что (меню, команды и рассылки в MAX —
 * позже). Остальные типы приходят вебхуком только по ошибке подписки и
 * принимаются без обработки.
 *
 * Форма — по `dev.max.ru/docs-api/objects/Update` на 12.11.2026: у события нет
 * своего идентификатора, поэтому повтор отсекается по паре «игрок + время» и
 * коду (`max-update-queue.ts`). Схема щедрая к лишним полям и строгая к тем, без
 * которых отвечать некому: событие без игрока разобрать нельзя, и повтор его
 * не исправит.
 */

export const BOT_STARTED = "bot_started";

/** Типы событий, на которые бот подписывается у MAX. */
export const SUBSCRIBED_UPDATE_TYPES: readonly string[] = [BOT_STARTED];

/** Код из ссылки — до 128 знаков (MAX обрезает длиннее); запас до 512 — как у поля в документации. */
const PAYLOAD_MAX = 512;

export const botStartedSchema = z.object({
  update_type: z.literal(BOT_STARTED),
  /** время события, мс */
  timestamp: z.number().int().nonnegative(),
  user: z.object({
    user_id: z.number().int().positive(),
    is_bot: z.boolean().optional(),
  }),
  /** код из `?start=<код>`; без параметра — `null` или поля нет */
  payload: z.string().max(PAYLOAD_MAX).nullish(),
});

export type MaxBotStarted = z.infer<typeof botStartedSchema>;

const typedSchema = z.object({ update_type: z.string() });

/** Тип события из тела вебхука; тело без типа — `null`. */
export function updateTypeOf(body: unknown): string | null {
  const parsed = typedSchema.safeParse(body);
  return parsed.success ? parsed.data.update_type : null;
}
