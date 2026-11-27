import { Module } from "@nestjs/common";
import { CARD_STORE, RedisCardStore } from "../../common/card/card-store.js";
import { CardPublisher } from "./card-publisher.js";
import { CardsController } from "./cards.controller.js";

/**
 * Картинки бота по публичному адресу (docs/35-stage4-plan.md Р156): PNG в Redis
 * по хэшу содержимого, отдача — `GET /api/v1/cards/<хэш>.png`, публикация для
 * других модулей — `CardPublisher`. Рисуют картинки модули сообщений
 * (приглашение, итог забега, сезон), а не этот.
 */
@Module({
  controllers: [CardsController],
  providers: [{ provide: CARD_STORE, useClass: RedisCardStore }, CardPublisher],
  exports: [CardPublisher, CARD_STORE],
})
export class CardsModule {}
