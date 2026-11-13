import { Injectable, Logger } from "@nestjs/common";
import { ExternalIdentityService } from "../../modules/external-identity/external-identity.service.js";
import { VkApi, type VkKeyboard } from "./vk-api.js";
import { VkCommunity } from "./vk-community.js";
import type { VkMessageEvent } from "./vk-events.js";

/**
 * Разбор сообщения, которое игрок написал сообществу VK (docs/35-stage4-plan.md
 * Р188, tasks/T-0378). Игрок пришёл по ссылке `vk.me/<сообщество>?ref=<код>`:
 * бот связывает его VK-id с игровым аккаунтом и отвечает, что делать дальше —
 * вступить в сообщество и нажать «Проверить» в игре.
 *
 * Связь записывает `ExternalIdentityService.consume` — одноразовый код, один
 * VK-id на один аккаунт (T-0377). Ответ после неё — вежливость, а не часть
 * записи: не ушёл — в лог, без повтора, иначе очередь повторила бы и
 * `consume`. А вот упавший `consume` — исключение: связь ещё не записана,
 * очередь повторит задание.
 */

const NO_REF = "Чтобы связать аккаунт, открой задание в игре и нажми «Открыть сообщество VK»";
const LINKED = "Готово! Аккаунт VK связан с игрой. Вступи в сообщество и вернись в игру — нажми «Проверить».";
const ALREADY = "Аккаунт уже связан. Вступи в сообщество и нажми «Проверить» в игре.";
const TAKEN = "Этот аккаунт VK уже связан с другим игроком. Связать его второй раз нельзя.";
const EXPIRED = "Ссылка устарела. Открой задание в игре и нажми «Открыть сообщество VK» ещё раз.";

const BUTTON_LABEL = "Перейти в сообщество";

interface Reply {
  text: string;
  /** добавить ссылку на сообщество отдельной строкой и кнопкой */
  withLink: boolean;
}

@Injectable()
export class VkUpdatesWorker {
  private readonly logger = new Logger("vk");

  constructor(
    private readonly identity: ExternalIdentityService,
    private readonly api: VkApi,
    private readonly community: VkCommunity,
  ) {}

  async handle(event: VkMessageEvent): Promise<void> {
    const userId = String(event.fromId);
    const reply = event.ref === null ? { text: NO_REF, withLink: false } : await this.link(event.ref, userId);
    await this.send(userId, reply);
  }

  private async link(code: string, userId: string): Promise<Reply> {
    const outcome = await this.identity.consume("vk", code, userId);
    switch (outcome) {
      case "linked":
        return { text: LINKED, withLink: true };
      case "already":
        return { text: ALREADY, withLink: true };
      case "taken":
        return { text: TAKEN, withLink: false };
      case "expired":
        return { text: EXPIRED, withLink: false };
    }
  }

  private async send(userId: string, reply: Reply): Promise<void> {
    const community = reply.withLink ? this.community.ref() : null;
    const text = community === null ? reply.text : `${reply.text}\n${community.url}`;
    const keyboard: VkKeyboard | undefined =
      community === null ? undefined : { inline: true, buttons: [[{ action: { type: "open_link", link: community.url, label: BUTTON_LABEL } }]] };
    try {
      await this.api.sendMessage(userId, text, keyboard);
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "vk", event: "vk_reply_failed", reason: error instanceof Error ? error.message : "unknown" }));
    }
  }
}
