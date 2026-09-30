import { addTranslations } from "./index";
import tasks from "./ru-tasks.json";

/**
 * Тексты заданий и достижений (docs/35-stage4-plan.md WP13) — своим
 * словарём: они нужны только их экрану, первая загрузка за них не платит
 * (docs/27-design-system-and-app-shell.md §3.4).
 */
addTranslations(tasks);

export const TASKS_TRANSLATIONS_READY = true;
