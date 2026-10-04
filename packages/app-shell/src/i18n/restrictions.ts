import { addTranslations } from "./index";
import restrictions from "./ru-restrictions.json";

/**
 * Тексты плашки ограничения (docs/35-stage4-plan.md WP44) — своим словарём:
 * он приезжает с плашкой, первая загрузка за него не платит
 * (docs/27-design-system-and-app-shell.md §3.4). Что закрыто и почему —
 * словами сервера, здесь только рамка вокруг них.
 */
addTranslations(restrictions);

export const RESTRICTIONS_TRANSLATIONS_READY = true;
