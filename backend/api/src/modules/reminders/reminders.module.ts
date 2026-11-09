import { Module } from "@nestjs/common";
import { AccountSettingsModule } from "../account-settings/account-settings.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { SeasonsModule } from "../seasons/seasons.module.js";
import { PrismaRemindersRepository, REMINDERS_REPOSITORY } from "./reminders.repository.js";
import { RemindersReport } from "./reminders.report.js";
import { RemindersScanner } from "./reminders.scanner.js";
import { RemindersStore } from "./reminders.store.js";

/**
 * Напоминания через бота (tasks/T-0128, docs/39-retention-mechanics.md П5):
 * обогнали в недельном сезоне, сезон закрывается завтра, награда дня ждёт.
 * Модуль только находит, кому напомнить, и пишет строку ленты — доставку в
 * бота, очередь под лимитером, тихие часы, потолок и выбор игрока держит
 * `notifications-bot`, кнопку «Не напоминать» принимает адаптер Telegram
 * (`platforms/telegram/reminders-off.command.ts`).
 *
 * Включается ключом `reminders.enabled` в панели; выключенный проход не трогает
 * ни Redis, ни базу. Таблицу недели и расписание сезонов читает у модуля сезонов.
 */
@Module({
  imports: [NotificationsModule, AccountSettingsModule, SeasonsModule],
  providers: [RemindersStore, RemindersReport, RemindersScanner, { provide: REMINDERS_REPOSITORY, useClass: PrismaRemindersRepository }],
})
export class RemindersModule {}
