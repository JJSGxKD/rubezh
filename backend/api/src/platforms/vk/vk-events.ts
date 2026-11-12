import { z } from "zod";

/**
 * События Callback API VK (docs/35-stage4-plan.md Р188, tasks/T-0378). VK шлёт
 * много полей, и лишнее разрешено: разбирается только то, что нужно боту.
 * Секрет контроллер читает до разбора, поэтому в схеме его нет.
 */

/** Конверт события: тип, сообщество и повторяющийся при повторной доставке `event_id`. */
export const callbackBodySchema = z.object({
  type: z.string().min(1).max(64),
  group_id: z.number().int().positive(),
  event_id: z.string().min(1).max(64).optional(),
  object: z.unknown().optional(),
});

export type CallbackBody = z.infer<typeof callbackBodySchema>;

/** `message_new`: от кого и с каким `ref` из ссылки `vk.me/<сообщество>?ref=…`. */
const messageObjectSchema = z.object({
  message: z.object({
    // Положительный id — человек, отрицательный — сообщество: боту отвечать некому.
    from_id: z.number().int().positive(),
    ref: z.string().max(128).optional(),
  }),
});

/**
 * Событие в очереди: только то, что нужно воркеру. Текст сообщения игрока в
 * Redis не уходит — он боту не нужен, а лишних данных очередь хранить не должна.
 */
export const vkMessageEventSchema = z.object({
  eventId: z.string().min(1).max(64).nullable(),
  groupId: z.number().int().positive(),
  fromId: z.number().int().positive(),
  ref: z.string().min(1).max(128).nullable(),
});

export type VkMessageEvent = z.infer<typeof vkMessageEventSchema>;

/** Новое сообщение сообществу из конверта; `null` — не от человека или без сообщения. */
export function messageEventOf(body: CallbackBody): VkMessageEvent | null {
  const parsed = messageObjectSchema.safeParse(body.object);
  if (!parsed.success) return null;
  const { from_id: fromId, ref } = parsed.data.message;
  return { eventId: body.event_id ?? null, groupId: body.group_id, fromId, ref: ref === undefined || ref === "" ? null : ref };
}
