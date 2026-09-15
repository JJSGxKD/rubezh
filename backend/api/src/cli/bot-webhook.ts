import { configFromEnvironment } from "../config/app-config.js";
import { TelegramBotApi } from "../modules/telegram/telegram-bot-api.js";

/**
 * Регистрация вебхука бота — идемпотентный шаг деплоя (docs/26-stage2-plan.md,
 * WP10): `setWebhook` с тем же адресом и токеном можно вызывать сколько угодно.
 *
 *   pnpm --filter backend-api bot:webhook            — зарегистрировать
 *   pnpm --filter backend-api bot:webhook --delete   — снять, вернуться к polling
 *
 * В контейнере — `node dist/cli/bot-webhook.js`. Токен и секрет в вывод не
 * попадают.
 */
async function main(): Promise<void> {
  const config = configFromEnvironment();
  if (config.telegram.botToken === "") throw new Error("Нужен TELEGRAM_BOT_TOKEN");
  const api = new TelegramBotApi(config.telegram.botToken);

  if (process.argv.includes("--delete")) {
    await api.deleteWebhook();
    console.log("Вебхук снят: бот снова может читать обновления long polling'ом");
    return;
  }

  if (config.telegram.publicApiUrl === "" || config.telegram.webhookSecret === "") {
    throw new Error("Нужны PUBLIC_API_URL и TELEGRAM_WEBHOOK_SECRET");
  }
  const url = `${config.telegram.publicApiUrl}/api/v1/bot/webhook`;
  await api.setWebhook(url, config.telegram.webhookSecret);
  console.log(`Вебхук зарегистрирован: ${url}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
