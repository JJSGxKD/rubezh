import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { ShopModule } from "../shop/shop.module.js";
import { ChangeKindRegistry } from "./change-request-kinds.js";
import { ChangeRequestsNotifier } from "./change-requests-notifier.js";
import { CHANGE_REQUESTS_REPOSITORY, PrismaChangeRequestsRepository } from "./change-requests.repository.js";
import { ChangeRequestsService } from "./change-requests.service.js";
import { SkuPriceKind } from "./sku-price.kind.js";

/**
 * Заявки на правку с подтверждением второго участника (docs/19-content-admin.md
 * §6, tasks/T-0309): цена товара меняется заявкой, которую подтверждает другой
 * человек с тем же правом. Маршруты — в модуле панели
 * (`admin/admin-change-requests.controller.ts`), здесь сервис, хранилище и виды
 * правок. Новый вид — класс рядом с `SkuPriceKind` и строка в реестре ниже.
 */
@Module({
  imports: [AuthModule, NotificationsModule, ShopModule],
  providers: [
    { provide: CHANGE_REQUESTS_REPOSITORY, useClass: PrismaChangeRequestsRepository },
    SkuPriceKind,
    { provide: ChangeKindRegistry, inject: [SkuPriceKind], useFactory: (skuPrice: SkuPriceKind) => new ChangeKindRegistry([skuPrice]) },
    ChangeRequestsNotifier,
    ChangeRequestsService,
  ],
  exports: [ChangeRequestsService],
})
export class ChangeRequestsModule {}
