import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { AccountRestrictions } from "./account-restrictions.js";
import { RestrictionsSettler } from "./restrictions-settler.js";
import { RestrictionsController } from "./restrictions.controller.js";
import { PrismaRestrictionsRepository, RESTRICTIONS_REPOSITORY } from "./restrictions.repository.js";
import { RestrictionsService } from "./restrictions.service.js";

/**
 * Ограничения игрока (docs/35-stage4-plan.md Р75, WP44): каталог видов,
 * наложение и снятие из панели, порт «можно ли» для модулей, у которых
 * игрок может злоупотребить наградой, и снятие последствий по сроку.
 */
@Module({
  imports: [AuthModule],
  controllers: [RestrictionsController],
  providers: [AccountRestrictions, RestrictionsService, RestrictionsSettler, { provide: RESTRICTIONS_REPOSITORY, useClass: PrismaRestrictionsRepository }],
  exports: [AccountRestrictions, RestrictionsService],
})
export class RestrictionsModule {}
