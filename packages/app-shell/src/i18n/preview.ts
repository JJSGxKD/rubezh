import { addTranslations } from "./index";
import preview from "./ru-preview.json";

/**
 * Тексты страницы предпросмотра для панели (docs/35-stage4-plan.md WP32) —
 * своим словарём: страница — отдельная сборка, игра за него не платит.
 */
addTranslations(preview);

export const PREVIEW_TRANSLATIONS_READY = true;
