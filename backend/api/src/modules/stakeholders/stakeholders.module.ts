import { Module } from "@nestjs/common";
import { PrismaStakeholdersRepository, STAKEHOLDERS_REPOSITORY } from "./stakeholders.repository.js";
import { StakeholdersService } from "./stakeholders.service.js";

/**
 * Доли участников проекта (docs/35-stage4-plan.md Р217): процент с месяца, история и предел суммы 100 %.
 * Маршруты — в панели (`admin/admin-stakeholders.controller.ts`); на этих долях строятся кабинет участника и
 * водопад закрытого месяца (`docs/37-accounting.md`). Роли и журнал — из глобального `RolesModule`.
 */
@Module({
  providers: [StakeholdersService, { provide: STAKEHOLDERS_REPOSITORY, useClass: PrismaStakeholdersRepository }],
  exports: [StakeholdersService],
})
export class StakeholdersModule {}
