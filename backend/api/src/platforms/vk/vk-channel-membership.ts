import type { ChannelMembership } from "../ports/channel-membership.js";
import type { VkApi } from "./vk-api.js";

/**
 * Вступление в сообщество VK для заданий (docs/35-stage4-plan.md Р188,
 * tasks/T-0378): спрашивает `groups.isMember` по VK-id, который игрок
 * связал с аккаунтом через бота сообщества. `chat` — то, что записано в
 * задании: короткое имя, ссылка, `club<id>` или id сообщества.
 */

/** id в VK — положительное число; связь хранит его строкой. */
const VK_USER_ID = /^[1-9]\d{0,11}$/;

export class VkChannelMembership implements ChannelMembership {
  readonly platform = "vk" as const;

  constructor(private readonly api: Pick<VkApi, "isMember">) {}

  async isMember(chat: string, platformUserId: string): Promise<boolean> {
    // Не VK-id (аккаунт разработчика, мусор в связи) — состоять в сообществе нечему, VK не спрашиваем.
    if (!VK_USER_ID.test(platformUserId)) return false;
    return await this.api.isMember(chat, platformUserId);
  }
}
