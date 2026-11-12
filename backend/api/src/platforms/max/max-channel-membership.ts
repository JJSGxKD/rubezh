import type { ChannelMembership } from "../ports/channel-membership.js";
import type { MaxBotApi } from "./max-bot-api.js";

/**
 * Подписка на канал MAX для заданий (docs/35-stage4-plan.md Р52, Р188,
 * tasks/T-0379). Бот — администратор канала: иначе MAX участников не
 * показывает, и это настройка задания, а не ответ «не подписан». Что значит
 * каждый отказ MAX — в `max-bot-api.ts`.
 *
 * `chat` — id канала из задания (`params.chat`, число), `platformUserId` — id
 * игрока в MAX, который связал бот (`ExternalIdentityService.externalId`).
 */
export class MaxChannelMembership implements ChannelMembership {
  readonly platform = "max" as const;

  constructor(private readonly api: Pick<MaxBotApi, "isChannelMember">) {}

  async isMember(chat: string, platformUserId: string): Promise<boolean> {
    return await this.api.isChannelMember(chat, platformUserId);
  }
}
