import { Module, type OnModuleInit } from "@nestjs/common";
import { IDENTITY_SOURCES, PublicIdentity, PublicIdentityModule } from "../../common/public-identity.js";
import { EMBLEMS_REPOSITORY, PrismaEmblemsRepository } from "../achievements/emblems.repository.js";
import { AuthModule } from "../auth/auth.module.js";
import { TasksModule } from "../tasks/tasks.module.js";
import { APPEARANCE_GRANTS_REPOSITORY, PrismaAppearanceGrantsRepository } from "./appearance-grants.repository.js";
import { AppearanceController } from "./appearance.controller.js";
import { APPEARANCE_REPOSITORY, PrismaAppearanceRepository } from "./appearance.repository.js";
import { AppearanceService } from "./appearance.service.js";

/**
 * Облики-архетипы (docs/35-stage4-plan.md Р150, tasks/T-0237): каталог из десяти обликов,
 * владение по состоянию аккаунта, выбор облика и кружка аватара. Экран — T-0238, облик в
 * забеге — T-0239.
 *
 * Рейтинг, сезон и друзья о обликах не знают: модуль при старте подключает к порту
 * `PublicIdentity` (T-0240) свой источник под именем `appearance`, рядом со знаком модуля
 * достижений. Сбой одного источника не стирает метки другого.
 *
 * Репозиторий знаков подключён здесь же вторым экземпляром: он без состояния, а VIP и лучшее
 * место в сезоне читаются его методами (T-0235), запросы не копируются. Так же подключён
 * репозиторий выдач (T-0245): строки в него пишет магазин, а читает владение — оба держат по
 * своему экземпляру, чтобы модуль магазина не тянул за собой модуль заданий.
 */
@Module({
  imports: [AuthModule, TasksModule, PublicIdentityModule],
  controllers: [AppearanceController],
  providers: [
    AppearanceService,
    { provide: APPEARANCE_REPOSITORY, useClass: PrismaAppearanceRepository },
    { provide: APPEARANCE_GRANTS_REPOSITORY, useClass: PrismaAppearanceGrantsRepository },
    { provide: EMBLEMS_REPOSITORY, useClass: PrismaEmblemsRepository },
  ],
  exports: [AppearanceService],
})
export class AppearanceModule implements OnModuleInit {
  constructor(
    private readonly appearance: AppearanceService,
    private readonly identity: PublicIdentity,
  ) {}

  onModuleInit(): void {
    this.identity.provide({ of: async (accountIds) => await this.appearance.of(accountIds) }, IDENTITY_SOURCES.appearance);
  }
}
