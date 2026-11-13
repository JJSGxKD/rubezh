import { Module } from "@nestjs/common";
import { FxModule } from "../fx/fx.module.js";
import { PROJECT_MONTH_REPOSITORY, PrismaProjectMonthRepository } from "./project-month.repository.js";
import { ProjectMonthService } from "./project-month.service.js";
import { PrismaStakeholdersRepository, STAKEHOLDERS_REPOSITORY } from "./stakeholders.repository.js";
import { StakeholdersService } from "./stakeholders.service.js";

/**
 * Доли участников проекта (docs/35-stage4-plan.md Р217): процент с месяца, история и предел суммы 100 %.
 * Маршруты — в панели (`admin/admin-stakeholders.controller.ts`); на этих долях строятся кабинет участника и
 * водопад закрытого месяца (`docs/37-accounting.md`). Месяц проекта для кабинета «Мой проект» (Р218, T-0453) — выручка
 * живыми оплатами по курсу выплаты, поэтому нужны курсы. Роли и журнал — из глобального `RolesModule`.
 */
@Module({
  imports: [FxModule],
  providers: [
    StakeholdersService,
    ProjectMonthService,
    { provide: STAKEHOLDERS_REPOSITORY, useClass: PrismaStakeholdersRepository },
    { provide: PROJECT_MONTH_REPOSITORY, useClass: PrismaProjectMonthRepository },
  ],
  exports: [StakeholdersService, ProjectMonthService],
})
export class StakeholdersModule {}
