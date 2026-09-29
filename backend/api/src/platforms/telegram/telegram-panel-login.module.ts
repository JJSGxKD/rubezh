import { Module } from "@nestjs/common";
import { AdminModule } from "../../modules/admin/admin.module.js";
import { BotModule } from "./bot.module.js";
import { PanelLoginCommand } from "./panel-login.command.js";

/**
 * Подтверждение входа в панель в боте (docs/29-admin-panel.md §8): домен
 * входа — в модуле панели, а бот только показывает запрос и передаёт нажатие.
 */
@Module({
  imports: [BotModule, AdminModule],
  providers: [PanelLoginCommand],
})
export class TelegramPanelLoginModule {}
