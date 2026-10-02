import { addTranslations } from "./index";
import ads from "./ru-ads.json";

/**
 * Тексты рекламного блока (docs/35-stage4-plan.md WP12, часть 9) — в его
 * чанке: блок грузится при первом показе креатива, и первая загрузка за его
 * подписи не платит (docs/27-design-system-and-app-shell.md §3.4).
 */
addTranslations(ads);

export const ADS_TRANSLATIONS_READY = true;
