import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { TestNoticeController } from "./test-notice.controller.js";
import { PrismaTestNoticeRepository, TEST_NOTICE_REPOSITORY } from "./test-notice.repository.js";
import { TestNoticeService } from "./test-notice.service.js";

/**
 * Предупреждение об открытом тесте (docs/35-stage4-plan.md Р59, WP33):
 * принятие на аккаунт с версией текста. Сервис экспортируется карточке
 * игрока в панели.
 */
@Module({
  imports: [AuthModule],
  controllers: [TestNoticeController],
  providers: [TestNoticeService, { provide: TEST_NOTICE_REPOSITORY, useClass: PrismaTestNoticeRepository }],
  exports: [TestNoticeService],
})
export class TestNoticeModule {}
