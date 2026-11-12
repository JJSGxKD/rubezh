import type { ExternalLinkStarter } from "../ports/external-link.js";
import type { VkCommunity } from "./vk-community.js";

/**
 * Ссылка на бота сообщества VK для связи аккаунтов (docs/35-stage4-plan.md
 * Р188, tasks/T-0378): `https://vk.me/<сообщество>?ref=<код>`. Когда игрок
 * пишет сообществу, событие `message_new` несёт `ref` с кодом и `from_id` —
 * его VK-id.
 *
 * Чистая функция: ничего не читает по сети, потому что её спрашивают при
 * каждом показе заданий. Ключа сообщества или настройки нет — `null`, и
 * задания VK игрокам не показываются.
 */
export class VkLinkStarter implements ExternalLinkStarter {
  readonly platform = "vk" as const;

  constructor(private readonly community: Pick<VkCommunity, "token" | "ref">) {}

  startUrl(code: string): string | null {
    if (this.community.token() === null) return null;
    const community = this.community.ref();
    if (community === null) return null;
    return `https://vk.me/${community.screenName}?ref=${encodeURIComponent(code)}`;
  }
}
