import { Inject, Injectable, Logger } from "@nestjs/common";
import type { MessageTopic, OutgoingMessage } from "../../platforms/ports/messenger.js";
import { plainTextOf, richProblems, type RichDocument } from "../../platforms/ports/rich-message.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";

/**
 * Сборка сообщения бота из документа (docs/35-stage4-plan.md Р199): простой
 * текст идёт всегда, оформленный вид — только когда включены `bot.formats.enabled`
 * и `bot.rich.enabled` и документ прошёл проверку. Остальное — дело площадки:
 * Telegram отправит оформленный вид, MAX и VK — простой текст.
 */

export interface MessageBase {
  button: OutgoingMessage["button"];
  action?: NonNullable<OutgoingMessage["action"]>;
  topic?: MessageTopic;
}

@Injectable()
export class BotMessages {
  private readonly logger = new Logger("bot-messages");

  constructor(@Inject(SETTINGS_READER) private readonly panel: SettingsReader) {}

  compose(doc: RichDocument, base: MessageBase): OutgoingMessage {
    const message: OutgoingMessage = {
      text: plainTextOf(doc),
      button: base.button,
      ...(base.action === undefined ? {} : { action: base.action }),
      ...(base.topic === undefined ? {} : { topic: base.topic }),
    };
    if (!this.panel.get(SETTINGS.botFormatsEnabled) || !this.panel.get(SETTINGS.botRichEnabled)) return message;
    const problems = richProblems(doc);
    if (problems.length > 0) {
      // Игрок получит тот же текст без оформления; а команде нужна строка, чтобы документ починили.
      this.logger.warn(JSON.stringify({ module: "bot-messages", event: "rich_rejected", problem: problems[0] }));
      return message;
    }
    return { ...message, rich: doc };
  }
}
