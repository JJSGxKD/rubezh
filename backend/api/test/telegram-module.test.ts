// Первым импортом идёт провайдер, а не модуль: круг импортов «модуль →
// провайдер → модуль» в ESM падает именно так — на загрузке того файла,
// который попросили первым. Порядок здесь не случайный и менять его нельзя.
import { BotIdentity } from "../src/modules/telegram/bot-identity.js";
import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { TELEGRAM_BOT_API, TelegramBotApi } from "../src/modules/telegram/telegram-bot-api.js";
import { TelegramModule } from "../src/modules/telegram/telegram.module.js";

// Сборка модуля Telegram. Тест существует ради одной ошибки: провайдер,
// которому нужен токен внедрения, не должен брать его из модуля, который сам
// же этого провайдера импортирует. Бэкенд тогда не поднимается вовсе
// («Cannot access 'TELEGRAM_BOT_API' before initialization»), а ловится это
// только запуском — ни typecheck, ни линт круга импортов не видят.

interface FactoryProvider {
  provide: unknown;
  inject: unknown[];
  useFactory: (config: AppConfig) => unknown;
}

function providersOf(module: unknown): unknown[] {
  return (Reflect.getMetadata("providers", module as object) as unknown[] | undefined) ?? [];
}

describe("модуль Telegram", () => {
  it("раздаёт клиент Bot API по токену и знает про имя бота", () => {
    const config = loadAppConfig({ NODE_ENV: "test", TELEGRAM_BOT_TOKEN: "1:TEST" });
    const providers = providersOf(TelegramModule);
    const factory = providers.find(
      (provider): provider is FactoryProvider =>
        typeof provider === "object" && provider !== null && (provider as FactoryProvider).provide === TELEGRAM_BOT_API,
    );

    expect(factory, "провайдер клиента Bot API").toBeDefined();
    expect(factory?.inject).toEqual([APP_CONFIG]);
    expect(factory?.useFactory(config)).toBeInstanceOf(TelegramBotApi);
    expect(providers).toContain(BotIdentity);
  });

  it("держит токен рядом с клиентом, а не в модуле", async () => {
    const fromModule: Record<string, unknown> = await import("../src/modules/telegram/telegram.module.js");

    expect(typeof TELEGRAM_BOT_API).toBe("symbol");
    expect(fromModule["TELEGRAM_BOT_API"]).toBeUndefined();
  });
});
