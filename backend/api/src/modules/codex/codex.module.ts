import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { TasksModule } from "../tasks/tasks.module.js";
import { CodexController } from "./codex.controller.js";
import { CODEX_REPOSITORY, PrismaCodexRepository } from "./codex.repository.js";
import { CodexService } from "./codex.service.js";

/**
 * Кодекс врагов (docs/39-retention-mechanics.md К2, tasks/T-0127): записи по
 * итогу забега и ответ для гайдбука. Награда — достижения каталога заданий,
 * поэтому модуль берёт у `TasksModule` прогресс и список, а забор остаётся там.
 * О забегах модуль знает только событие `RunsHooks`.
 */
@Module({
  imports: [AuthModule, RunsModule, TasksModule],
  controllers: [CodexController],
  providers: [CodexService, { provide: CODEX_REPOSITORY, useClass: PrismaCodexRepository }],
  exports: [CodexService],
})
export class CodexModule {}
