import { addTranslations } from "./index";
import emblems from "./ru-emblems.json";

/**
 * Тексты знаков у имени (docs/35-stage4-plan.md Р149, tasks/T-0236) — своим
 * словарём: их читают профиль, рейтинг и друзья, а первая загрузка за них не
 * платит (docs/27-design-system-and-app-shell.md §3.4).
 */
addTranslations(emblems);

export const EMBLEMS_TRANSLATIONS_READY = true;
