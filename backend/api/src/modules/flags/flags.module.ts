import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { FlagsController } from "./flags.controller.js";
import { FLAGS_REPOSITORY, PrismaFlagsRepository } from "./flags.repository.js";
import { FlagsService } from "./flags.service.js";

/** Фича-флаги (WP17): вычисление для игрока, управление — из панели. */
@Module({
  imports: [AuthModule],
  controllers: [FlagsController],
  providers: [FlagsService, { provide: FLAGS_REPOSITORY, useClass: PrismaFlagsRepository }],
  exports: [FlagsService],
})
export class FlagsModule {}
