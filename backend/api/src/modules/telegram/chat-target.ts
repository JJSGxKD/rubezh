/**
 * Куда слать сообщение: чат и, если это супергруппа с темами, — тема
 * (docs/20-env-and-ports.md §3). В окружении пишется одной строкой:
 * `-1001234567890` или `-1001234567890:57`.
 *
 * Тема нужна там, где чат администраторов один, а поток разный: сводка
 * плейтеста, стресс-тесты и проблемные забеги не должны мешаться.
 */
export interface ChatTarget {
  chatId: string;
  /** `null` — чат без тем или общая лента */
  threadId: number | null;
}

/** Куда угодно, где нужен адрес: разобранная цель или голый id чата. */
export type ChatRef = ChatTarget | string;

const CHAT_TARGET = /^(-?\d{1,20})(?::(\d{1,10}))?$/;

export function isChatTarget(value: string): boolean {
  return value === "" || CHAT_TARGET.test(value);
}

/** `null` — пусто или не разбирается: проверку формата делает схема конфигурации. */
export function parseChatTarget(value: string): ChatTarget | null {
  const match = CHAT_TARGET.exec(value.trim());
  if (match === null) return null;
  const thread = match[2];
  return { chatId: match[1] ?? "", threadId: thread === undefined ? null : Number(thread) };
}

export function chatTargetOf(ref: ChatRef): ChatTarget {
  return typeof ref === "string" ? { chatId: ref, threadId: null } : ref;
}

/** Поля запроса Bot API: тема добавляется, только когда она есть. */
export function chatFields(ref: ChatRef): { chat_id: string; message_thread_id?: number } {
  const target = chatTargetOf(ref);
  return target.threadId === null ? { chat_id: target.chatId } : { chat_id: target.chatId, message_thread_id: target.threadId };
}

/** Один ли это чат — тема адрес чата не меняет. */
export function sameChat(ref: ChatRef, chatId: string): boolean {
  return chatTargetOf(ref).chatId === chatId;
}
