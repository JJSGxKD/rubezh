import { addTranslations } from "./index";
import daily from "./ru-daily.json";

/**
 * Тексты награды дня (docs/35-stage4-plan.md WP13) — своим словарём: они
 * нужны только её экрану, первая загрузка за них не платит
 * (docs/27-design-system-and-app-shell.md §3.4).
 */
addTranslations(daily);

export const DAILY_TRANSLATIONS_READY = true;
