import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { FxHooks } from "./fx-hooks.js";
import { FxRefresher } from "./fx.refresher.js";
import { FxService } from "./fx.service.js";
import { FX_STORE, PrismaRateStore } from "./fx.store.js";

/**
 * Курсы валют (docs/35-stage4-plan.md, §3.12, WP9): тонкий модуль вокруг ядра
 * `packages/fx` — хранилище на Postgres, проход по расписанию под локом,
 * эндпоинты панели — в `modules/admin`. Алерты в чат команды — через хуки, доставку берёт
 * `admin-notify`.
 */
@Module({
  imports: [AuthModule],
  providers: [FxService, FxRefresher, FxHooks, { provide: FX_STORE, useClass: PrismaRateStore }],
  exports: [FxService, FxHooks],
})
export class FxModule {}
