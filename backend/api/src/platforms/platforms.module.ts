import { Global, Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app-config.js";
import { AppLinks } from "./ports/app-links.js";
import { LaunchVerifiers } from "./ports/launch-verifier.js";
import { Messengers } from "./ports/messenger.js";
import { PaymentProviders } from "./ports/payment-provider.js";
import { TELEGRAM_BOT_API, type TelegramBotApi } from "./telegram/telegram-bot-api.js";
import { BotIdentity } from "./telegram/bot-identity.js";
import { TelegramAppLinks } from "./telegram/telegram-app-links.js";
import { TelegramStarsProvider } from "./telegram/telegram-stars-provider.js";
import { TelegramLaunchVerifier } from "./telegram/telegram-launch-verifier.js";
import { TelegramMessenger } from "./telegram/telegram-messenger.js";
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

/** Ссылка запуска приложения: пока только Telegram — у MAX и VK приложений ещё нет. */
export function appLinksFor(identity: BotIdentity): AppLinks {
  return new AppLinks([new TelegramAppLinks(identity)]);
}

/** Сообщения игрокам: пока только бот Telegram — у MAX и VK ботов ещё нет. */
export function messengersFor(config: AppConfig, telegramApi: TelegramBotApi): Messengers {
  return new Messengers([new TelegramMessenger(telegramApi, config.telegram.botToken !== "")]);
}

@Global()
@Module({
  providers: [
    { provide: LaunchVerifiers, inject: [APP_CONFIG], useFactory: launchVerifiersFor },
    { provide: PaymentProviders, inject: [APP_CONFIG, TELEGRAM_BOT_API], useFactory: paymentProvidersFor },
    { provide: AppLinks, inject: [BotIdentity], useFactory: appLinksFor },
    { provide: Messengers, inject: [APP_CONFIG, TELEGRAM_BOT_API], useFactory: messengersFor },
  ],
  exports: [LaunchVerifiers, PaymentProviders, AppLinks, Messengers],
})
export class PlatformsModule {}
