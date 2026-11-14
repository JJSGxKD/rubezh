import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { TasksModule } from "../tasks/tasks.module.js";
import { SecretsCodexController } from "./secrets-codex.controller.js";
import { SECRETS_CODEX_REPOSITORY, PrismaSecretsCodexRepository } from "./secrets-codex.repository.js";
import { SecretsCodexService } from "./secrets-codex.service.js";

/**
 * Кодекс тайников (design/art/meta-v2.md §5.3, tasks/T-0261): виды по итогу
 * забега и ответ для гайдбука. Награда — достижение каталога заданий, поэтому
 * модуль берёт у `TasksModule` прогресс и список. О забегах модуль знает только
 * событие `RunsHooks`.
 */
@Module({
  imports: [AuthModule, RunsModule, TasksModule],
  controllers: [SecretsCodexController],
  providers: [SecretsCodexService, { provide: SECRETS_CODEX_REPOSITORY, useClass: PrismaSecretsCodexRepository }],
  exports: [SecretsCodexService],
})
export class SecretsCodexModule {}
