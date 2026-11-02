import { Inject, Injectable, Logger, Module, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { ACCOUNT_SETTINGS_VERSION } from "../../modules/account-settings/account-settings.catalog.js";
import { AccountSettingsModule } from "../../modules/account-settings/account-settings.module.js";
import { AccountSettingsService } from "../../modules/account-settings/account-settings.service.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../../modules/auth/account.repository.js";
import { AuthModule } from "../../modules/auth/auth.module.js";
import { REMINDER_OFF_DATA } from "../../modules/reminders/reminder-rules.js";
import { BotModule } from "./bot.module.js";
import { BotRouter, type BotUpdateHandler } from "./bot-router.js";
import { TELEGRAM_BOT_API, type TelegramBotApi, type TelegramUpdate } from "./telegram-bot-api.js";

/**
 * Кнопка «Не напоминать» под напоминанием бота (tasks/T-0128). Нажатие
 * выключает ключ аккаунта `bot.reminders` — один на все три вида напоминаний;
 * включить обратно можно в настройках игры.
 *
 * Выключается аккаунт того, кто нажал (`callback_query.from`), а не того, кому
 * пришло сообщение: пересланную кнопку нажмёт другой человек — и выключит
 * напоминания себе. Поэтому ни личный чат, ни владелец сообщения не проверяются.
 * Повтор безвреден: запись «выкл.» ставится заново, ответ тот же. Неизвестному
 * игроку отвечаем так же и ничего не пишем: по ответу не узнать, есть ли у
 * кого-то аккаунт.
 */

export type RemindersOffBotApi = Pick<TelegramBotApi, "answerCallbackQuery">;

const REPLY = "Напоминания выключены. Включить их снова можно в настройках игры.";
const REMINDERS_KEY = "bot.reminders";

@Injectable()
export class RemindersOffCommand implements BotUpdateHandler, OnModuleInit, OnModuleDestroy {
  readonly name = "reminders-off";
  private readonly logger = new Logger("bot");
  private readonly stop = new AbortController();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly router: BotRouter,
    @Inject(TELEGRAM_BOT_API) private readonly api: RemindersOffBotApi,
    // Токены — явно: у `Pick` в метаданных типов остаётся `Object`, и Nest не нашёл бы, что внедрять.
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: Pick<AccountRepository, "byPlatformUser">,
    @Inject(AccountSettingsService) private readonly settings: Pick<AccountSettingsService, "merge">,
  ) {}

  /** Без чтения обновлений нажатий не будет, без входа игроков нет и аккаунтов. */
  onModuleInit(): void {
    if (this.config.telegram.updates !== "off" && this.config.auth.enabled) this.router.register(this);
  }

  onModuleDestroy(): void {
    this.stop.abort();
  }

  async handle(update: TelegramUpdate): Promise<boolean> {
    const query = update.callback_query;
    // Строгое равенство: чужой формат данных — не наша кнопка, её возьмёт другой обработчик.
    if (query === undefined || query.data !== REMINDER_OFF_DATA) return false;
    const account = await this.accounts.byPlatformUser("telegram", String(query.from.id));
    if (account === null) {
      this.logger.log(JSON.stringify({ module: "bot", event: "reminders_off_unknown_player" }));
    } else {
      // Часы сервера: возраст выбора 0 — «выбрано сейчас», позднее выбор в игре его перебьёт.
      await this.settings.merge(account, { version: ACCOUNT_SETTINGS_VERSION, values: { [REMINDERS_KEY]: { value: false, ageMs: 0 } } });
    }
    await this.api.answerCallbackQuery(query.id, REPLY, this.stop.signal);
    return true;
  }
}

/**
 * Модуль команды лежит рядом с ней: доменному модулю напоминаний нельзя знать
 * адаптер Telegram (`scripts/test/layer-boundaries.test.ts`), а нажатие кнопки —
 * это Telegram.
 */
@Module({
  imports: [BotModule, AuthModule, AccountSettingsModule],
  providers: [RemindersOffCommand],
})
export class RemindersOffModule {}
