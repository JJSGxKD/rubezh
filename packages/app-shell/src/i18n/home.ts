import { addTranslations } from "./index";
import home from "./ru-home.json";

/**
 * Тексты карусели главной (docs/35-stage4-plan.md WP42) — своим словарём:
 * он приезжает с чанком карусели после первого кадра, первая загрузка за
 * него не платит (docs/27-design-system-and-app-shell.md §3.4).
 */
addTranslations(home);

export const HOME_TRANSLATIONS_READY = true;
