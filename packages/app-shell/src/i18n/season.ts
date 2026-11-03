import { addTranslations } from "./index";
import season from "./ru-season.json";

/**
 * Тексты недельного сезона и вкладок рейтинга (tasks/T-0111) — своим
 * словарём: они нужны только экрану рейтинга, первая загрузка за них не
 * платит (docs/27-design-system-and-app-shell.md §3.4).
 */
addTranslations(season);

export const SEASON_TRANSLATIONS_READY = true;
