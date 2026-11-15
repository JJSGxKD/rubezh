import { z } from "zod";

/**
 * Входящие обновления Telegram — граница системы: разбираются схемой, а не
 * приводятся. Схемы терпимы к незнакомым полям (Telegram их добавляет), а
 * обновление, не прошедшее разбор, пропускается и не роняет приём.
 */

const userSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean(),
  first_name: z.string().max(256).optional(),
  last_name: z.string().max(256).optional(),
  username: z.string().max(64).optional(),
  language_code: z.string().max(16).optional(),
  is_premium: z.boolean().optional(),
});

const chatSchema = z.object({ id: z.number().int(), type: z.string() });

/**
 * Данные кнопки виджета — до 64 **байт**, а не знаков: кириллица занимает по
 * два. Длина в знаках не больше длины в байтах, поэтому `max(64)` — только
 * дешёвая первая отсечка.
 */
const widgetDataSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 64, "data длиннее 64 байт");

/** Вид запроса: подробности вида нам не нужны, незнакомые поля терпим. */
const widgetQueryTypeSchema = z.object({ type: z.string().max(32) });

/**
 * Оплата и её возврат в Stars — сообщения от Telegram в личном чате с
 * игроком. Границы щедрые: обновление, не прошедшее схему, пропускается, а
 * пропущенная оплата — это звёзды без продолжения.
 */
const paymentSchema = z.object({
  currency: z.string().max(16),
  total_amount: z.number().int(),
  invoice_payload: z.string().max(256),
  telegram_payment_charge_id: z.string().min(1).max(256),
});

export const updateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      message_id: z.number().int(),
      date: z.number().int(),
      text: z.string().optional(),
      chat: chatSchema,
      /** тема супергруппы, если сообщение пришло из неё — ответ уходит туда же */
      message_thread_id: z.number().int().optional(),
      from: userSchema.optional(),
      successful_payment: paymentSchema.optional(),
      refunded_payment: paymentSchema.optional(),
      /** служебное: игрок разрешил боту писать ему — из Mini App (`requestWriteAccess`) или при входе */
      write_access_allowed: z.object({}).optional(),
    })
    .optional(),
  /** игрок отменил или вернул продление подписки в Telegram, или очередное списание не прошло */
  subscription: z
    .object({
      user: userSchema,
      invoice_payload: z.string().max(256),
      state: z.string().max(16),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string().max(128),
      from: userSchema,
      data: z.string().max(64).optional(),
      message: z
        .object({ message_id: z.number().int(), chat: chatSchema, message_thread_id: z.number().int().optional() })
        .optional(),
    })
    .optional(),
  pre_checkout_query: z
    .object({
      id: z.string().max(256),
      from: userSchema,
      currency: z.string().max(16),
      total_amount: z.number().int(),
      invoice_payload: z.string().max(256),
    })
    .optional(),
  /** касание в живой карточке-виджете: Telegram ждёт ответа 15 секунд */
  widget_query: z
    .object({
      id: z.string().max(256),
      from: userSchema,
      chat: chatSchema.optional(),
      message_id: z.number().int().optional(),
      inline_message_id: z.string().max(256).optional(),
      chat_instance: z.string().max(256),
      chat_type: z.string().max(32).optional(),
      type: widgetQueryTypeSchema,
      data: widgetDataSchema,
      widget_id: z.string().max(256).optional(),
    })
    .optional(),
  /** то же из общего виджета: виден многим чатам, поэтому у него всегда есть `widget_id` */
  shared_widget_query: z
    .object({
      id: z.string().max(256),
      from: userSchema,
      type: widgetQueryTypeSchema,
      data: widgetDataSchema,
      widget_id: z.string().max(256),
    })
    .optional(),
  /** статус бота в чате изменился: в личке `kicked` — игрок заблокировал бота, `member` — разблокировал */
  my_chat_member: z
    .object({
      chat: chatSchema,
      from: userSchema,
      date: z.number().int(),
      new_chat_member: z.object({ status: z.string().max(32) }),
    })
    .optional(),
});

export type TelegramUpdate = z.infer<typeof updateSchema>;
export type TelegramUser = z.infer<typeof userSchema>;
