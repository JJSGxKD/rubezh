import { addTranslations } from "./index";
import appearance from "./ru-appearance.json";

/**
 * Тексты обликов героя (docs/35-stage4-plan.md Р150, tasks/T-0238) — своим
 * словарём: их читают экран «Облик», арсенал и профиль, а первая загрузка за
 * них не платит (docs/27-design-system-and-app-shell.md §3.4).
 */
addTranslations(appearance);

export const APPEARANCE_TRANSLATIONS_READY = true;
