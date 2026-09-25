import { Global, Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { LaunchVerifiers } from "./ports/launch-verifier.js";
import { PaymentProviders } from "./ports/payment-provider.js";
import { TELEGRAM_BOT_API, type TelegramBotApi } from "./telegram/telegram-bot-api.js";
import { TelegramStarsProvider } from "./telegram/telegram-stars-provider.js";
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

/** Оплата: у Telegram — звёзды; у MAX и VK способов оплаты пока нет, и продажа там не предлагается. */
export function paymentProvidersFor(config: AppConfig, telegramApi: TelegramBotApi): PaymentProviders {
  return new PaymentProviders([new TelegramStarsProvider(telegramApi, config.telegram.updates !== "off")]);
}

@Global()
@Module({
  providers: [
    { provide: LaunchVerifiers, inject: [APP_CONFIG], useFactory: launchVerifiersFor },
    { provide: PaymentProviders, inject: [APP_CONFIG, TELEGRAM_BOT_API], useFactory: paymentProvidersFor },
  ],
  exports: [LaunchVerifiers, PaymentProviders],
})
export class PlatformsModule {}
