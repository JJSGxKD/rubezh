import { addTranslations } from "./index";
import bot from "./ru-bot.json";

/**
 * Тексты раздела «Сообщения в боте» в настройках (docs/35-stage4-plan.md
 * WP28) — своим словарём: они нужны только экрану настроек, первая загрузка за
 * них не платит (docs/27-design-system-and-app-shell.md §3.4).
 */
addTranslations(bot);

export const BOT_TRANSLATIONS_READY = true;
