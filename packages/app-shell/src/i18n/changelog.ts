import { addTranslations } from "./index";
import changelog from "./ru-changelog.json";

/**
 * Тексты журнала обновлений (docs/35-stage4-plan.md WP31) — своим словарём:
 * они нужны только экрану «Что нового», первая загрузка за них не платит
 * (docs/27-design-system-and-app-shell.md §3.4).
 */
addTranslations(changelog);

export const CHANGELOG_TRANSLATIONS_READY = true;
