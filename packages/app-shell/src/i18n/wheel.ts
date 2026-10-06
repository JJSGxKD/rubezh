import { addTranslations } from "./index";
import wheel from "./ru-wheel.json";

/**
 * Тексты колеса (docs/35-stage4-plan.md WP13) — своим словарём: они нужны
 * только его экрану, первая загрузка за них не платит
 * (docs/27-design-system-and-app-shell.md §3.4).
 */
addTranslations(wheel);

export const WHEEL_TRANSLATIONS_READY = true;
