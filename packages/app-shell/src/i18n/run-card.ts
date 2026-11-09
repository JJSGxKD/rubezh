import { addTranslations } from "./index";
import runCard from "./ru-run-card.json";

/**
 * Тексты карточки забега (tasks/T-0297) — своим словарём: они нужны только
 * карточке и строке «Очки · стиль» на экране итогов, первая загрузка за них
 * не платит (docs/27-design-system-and-app-shell.md §3.4).
 */
addTranslations(runCard);

export const RUN_CARD_TRANSLATIONS_READY = true;
