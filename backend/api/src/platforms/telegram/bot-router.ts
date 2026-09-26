import { Injectable, Logger } from "@nestjs/common";
import type { TelegramUpdate } from "./telegram-bot-api.js";

/**
 * Обработчик обновлений бота. Модули регистрируют свои команды сами —
 * модуль бота не знает ни про сводку плейтеста, ни про выгрузку, и новая
 * команда не требует правки маршрутизатора.
 */
export interface BotUpdateHandler {
  /** имя для логов: чей обработчик упал */
  readonly name: string;
  /** команды обработчика — для меню Telegram и `/help`; без них команда скрытая */
  readonly commands?: readonly BotCommandSpec[];
  /** `true` — обновление обработано, следующим обработчикам оно не передаётся */
  handle(update: TelegramUpdate): Promise<boolean>;
}

/** Команда бота: кому её показывать и что она делает. */
export interface BotCommandSpec {
  /** без ведущего слеша */
  command: string;
  description: string;
  /**
   * Описание для английского интерфейса Telegram. Нужно командам для всех:
   * их видят игроки на любом языке; команды администратора — только русские.
   */
  descriptionEn?: string;
  audience: "everyone" | "admin";
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

  /** Все команды зарегистрированных обработчиков в порядке регистрации. */
  commands(): BotCommandSpec[] {
    return this.handlers.flatMap((handler) => [...(handler.commands ?? [])]);
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
