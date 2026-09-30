import { addTranslations } from "./index";
import shop from "./ru-shop.json";

/**
 * Тексты магазина и VIP (docs/35-stage4-plan.md WP10) — своим словарём: они
 * нужны только экрану магазина, первая загрузка за них не платит
 * (docs/27-design-system-and-app-shell.md §3.4).
 */
addTranslations(shop);

export const SHOP_TRANSLATIONS_READY = true;
