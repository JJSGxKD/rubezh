import { addTranslations } from "./index";
import history from "./ru-history.json";

/**
 * Тексты истории имущества (docs/35-stage4-plan.md Р51) — своим словарём:
 * подписи причин и видов нужны только экрану истории, первая загрузка за них
 * не платит (docs/27-design-system-and-app-shell.md §3.4).
 */
addTranslations(history);

export const HISTORY_TRANSLATIONS_READY = true;
