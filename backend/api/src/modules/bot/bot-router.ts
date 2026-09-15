import { Injectable, Logger } from "@nestjs/common";
import type { TelegramUpdate } from "../telegram/telegram-bot-api.js";

/**
 * Обработчик обновлений бота. Модули регистрируют свои команды сами —
 * модуль бота не знает ни про сводку плейтеста, ни про выгрузку, и новая
 * команда не требует правки маршрутизатора.
 */
export interface BotUpdateHandler {
  /** имя для логов: чей обработчик упал */
  readonly name: string;
  /** `true` — обновление обработано, следующим обработчикам оно не передаётся */
  handle(update: TelegramUpdate): Promise<boolean>;
}

/**
 * Одна точка входа обновлений — и для long polling, и для вебхука: откуда
 * пришло обновление, обработчику всё равно.
 */
@Injectable()
export class BotRouter {
  private readonly logger = new Logger("bot");
  private readonly handlers: BotUpdateHandler[] = [];

  register(handler: BotUpdateHandler): void {
    this.handlers.push(handler);
  }

  async dispatch(update: TelegramUpdate): Promise<void> {
    for (const handler of this.handlers) {
      try {
        if (await handler.handle(update)) return;
      } catch (error: unknown) {
        // Упавший обработчик не должен ронять чтение обновлений: следующее
        // обновление — уже другая команда другого человека.
        this.logger.error(
          JSON.stringify({
            module: "bot",
            event: "handler_failed",
            handler: handler.name,
            updateId: update.update_id,
            reason: error instanceof Error ? error.message : "unknown",
          }),
        );
        return;
      }
    }
  }
}
