import { Module } from "@nestjs/common";
import { MediaController } from "./media.controller.js";
import { MEDIA_REPOSITORY, PrismaMediaRepository } from "./media.repository.js";
import { MediaService } from "./media.service.js";

/**
 * Картинки из панели (docs/35-stage4-plan.md О42): в базе до CDN, адрес — хэш
 * содержимого. Загрузка — в панели (`admin/media`), отдача игроку — здесь.
 */
@Module({
  controllers: [MediaController],
  providers: [MediaService, { provide: MEDIA_REPOSITORY, useClass: PrismaMediaRepository }],
  exports: [MediaService],
})
export class MediaModule {}
