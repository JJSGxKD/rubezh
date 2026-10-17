import { Module } from "@nestjs/common";
import { ClientScriptsController } from "./client-scripts.controller.js";
import { ClientScripts } from "./client-scripts.service.js";

/**
 * Выключатели чужих скриптов клиента (docs/35-stage4-plan.md Р93): Graspil,
 * SDK учёта аудитории и всё сразу — настройками панели, без релиза.
 */
@Module({
  controllers: [ClientScriptsController],
  providers: [ClientScripts],
  exports: [ClientScripts],
})
export class ClientScriptsModule {}
