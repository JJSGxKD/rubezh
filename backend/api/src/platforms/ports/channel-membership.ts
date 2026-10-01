import type { PlatformId } from "./platform.js";

/**
 * Состоит ли игрок в канале или чате площадки (docs/35-stage4-plan.md Р52):
 * задание «подписаться на канал проекта» выполняет подписка, а проверяет её
 * бот площадки. Какой канал — строка каталога заданий; как площадка
 * отвечает на вопрос «состоит ли», знает только её адаптер.
 */

/** Площадка не ответила — повтор может помочь. */
export class MembershipUnavailableError extends Error {
  override readonly name = "MembershipUnavailableError";
}

/**
 * Площадка проверить не может и не сможет без человека: канала нет, бота в
 * нём нет или у него нет права видеть участников. Это ошибка настройки
 * задания, а не игрока.
 */
export class MembershipRejectedError extends Error {
  override readonly name = "MembershipRejectedError";
}

export interface ChannelMembership {
  readonly platform: PlatformId;
  /**
   * @param chat канал или чат в записи площадки: у Telegram — `@имя` или id
   * @param platformUserId кто — идентификатор игрока на площадке
   */
  isMember(chat: string, platformUserId: string): Promise<boolean>;
}

/** Проверки всех площадок: домен выбирает по площадке аккаунта. */
export class ChannelMemberships {
  constructor(private readonly all: readonly ChannelMembership[]) {}

  for(platform: PlatformId): ChannelMembership | null {
    return this.all.find((membership) => membership.platform === platform) ?? null;
  }
}
