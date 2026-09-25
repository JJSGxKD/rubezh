import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { MessagingService } from "../../modules/messaging/messaging.service.js";
import type { MessagingReason } from "../../modules/messaging/messaging.repository.js";
import { BotRouter, type BotUpdateHandler } from "./bot-router.js";
import type { TelegramUpdate } from "./telegram-bot-api.js";

/**
 * Что Telegram сообщает о том, можно ли писать игроку (docs/35-stage4-plan.md,
 * §3.10): блокировка и разблокировка бота — `my_chat_member` в личке,
 * разрешение из Mini App — служебное сообщение `write_access_allowed`.
 * Обработчик только переводит их в причины домена.
 */
@Injectable()
export class TelegramMessagingHandler implements BotUpdateHandler, OnModuleInit {
  readonly name = "messaging";

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly router: BotRouter,
    private readonly messaging: MessagingService,
  ) {}

  onModuleInit(): void {
    // Без базы состояние некуда записать, без чтения обновлений — неоткуда узнать.
    if (this.config.telegram.updates !== "off" && this.config.databaseUrl !== "") this.router.register(this);
  }

  async handle(update: TelegramUpdate): Promise<boolean> {
    const member = update.my_chat_member;
    if (member !== undefined) {
      // В группах бота добавляют и убирают администраторы — к игроку это не относится.
      if (member.chat.type !== "private") return true;
      const reason = reasonOf(member.new_chat_member.status);
      if (reason !== null) await this.messaging.platformChanged("telegram", String(member.from.id), reason, new Date(member.date * 1000));
      return true;
    }

    const message = update.message;
    if (message?.write_access_allowed !== undefined && message.from !== undefined) {
      await this.messaging.platformChanged("telegram", String(message.from.id), "write_access", new Date(message.date * 1000));
      return true;
    }
    return false;
  }
}

/** `kicked` — заблокировал, `member` — снова разрешил; прочие статусы в личке о разрешении ничего не говорят. */
function reasonOf(status: string): MessagingReason | null {
  if (status === "kicked") return "blocked";
  if (status === "member") return "unblocked";
  return null;
}
