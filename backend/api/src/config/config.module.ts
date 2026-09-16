import { Global, Module } from "@nestjs/common";
import { APP_CONFIG, loadAppConfig, loadRootEnv } from "./app-config.js";

/**
 * Конфигурация читается один раз при старте и раздаётся через DI.
 * Прямое обращение к process.env за пределами app-config.ts запрещено
 * (CLAUDE.md, «Порты и переменные окружения»).
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: () => {
        loadRootEnv();
        return loadAppConfig(process.env);
      },
    },
  ],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}
