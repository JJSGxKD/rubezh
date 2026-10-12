import { Module } from "@nestjs/common";
import { AdminModule } from "../../modules/admin/admin.module.js";
import { BotModule } from "./bot.module.js";
import { PanelLoginCommand } from "./panel-login.command.js";
import { RoleConfirmCommand } from "./role-confirm.command.js";

/**
 * Подтверждение входа в панель в боте (docs/29-admin-panel.md §8): домен
 * входа — в модуле панели, а бот только показывает запрос и передаёт нажатие.
 * Так же — подтверждение выдачи ролей владельца и администратора
 * (`role-confirm.command.ts`, §3.4).
 */
@Module({
  imports: [BotModule, AdminModule],
  providers: [PanelLoginCommand, RoleConfirmCommand],
})
export class TelegramPanelLoginModule {}
