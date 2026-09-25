import { Global, Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { LaunchVerifiers } from "./ports/launch-verifier.js";
import { TelegramLaunchVerifier } from "./telegram/telegram-launch-verifier.js";
import { UnsupportedLaunchVerifier } from "./unsupported.js";

/**
 * Реализации портов площадок для всего бэкенда (docs/35-stage4-plan.md,
 * §3.11): домен просит порт, а какой адаптер за ним — решается здесь. Порт
 * на новую площадку — это строка в этом списке и её адаптер, а не правка
 * доменных модулей.
 */
export function launchVerifiersFor(config: AppConfig): LaunchVerifiers {
  return new LaunchVerifiers([
    new TelegramLaunchVerifier(config.telegram.botToken),
    new UnsupportedLaunchVerifier("max"),
    new UnsupportedLaunchVerifier("vk"),
  ]);
}

@Global()
@Module({
  providers: [{ provide: LaunchVerifiers, inject: [APP_CONFIG], useFactory: launchVerifiersFor }],
  exports: [LaunchVerifiers],
})
export class PlatformsModule {}
