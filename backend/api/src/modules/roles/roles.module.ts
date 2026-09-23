import { Global, Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { RolesController } from "./roles.controller.js";
import { PermissionGuard } from "./permission.guard.js";
import { PrismaRolesRepository, ROLES_REPOSITORY } from "./roles.repository.js";
import { RolesService } from "./roles.service.js";

/**
 * Роли, права и журнал аудита (docs/34-stage3-plan.md, WP2).
 *
 * Модуль глобальный: правами закрываются эндпоинты любого модуля, а аудит
 * пишут все, кто трогает чужие данные, — тащить импорт в каждый модуль
 * значило бы просто переписать `@Global` руками.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [RolesController],
  providers: [RolesService, PermissionGuard, { provide: ROLES_REPOSITORY, useClass: PrismaRolesRepository }],
  exports: [RolesService, PermissionGuard],
})
export class RolesModule {}
