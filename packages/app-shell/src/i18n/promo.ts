import { addTranslations } from "./index";
import promo from "./ru-promo.json";

/**
 * Тексты экрана промокода (docs/35-stage4-plan.md WP41) — своим словарём:
 * они нужны только ему, первая загрузка за них не платит
 * (docs/27-design-system-and-app-shell.md §3.4).
 */
addTranslations(promo);

export const PROMO_TRANSLATIONS_READY = true;
