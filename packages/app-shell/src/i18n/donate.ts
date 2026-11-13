import { addTranslations } from "./index";
import donate from "./ru-donate.json";

/**
 * Тексты доната проекту (docs/35-stage4-plan.md, Р109, T-0158) — своим
 * словарём: блок стоит на «Об игре» и в профиле, лист открывается по нажатию,
 * первая загрузка за них не платит (docs/27-design-system-and-app-shell.md
 * §3.4). Слово знака «Меценат» лежит в основном словаре — знак виден на трёх
 * экранах.
 */
addTranslations(donate);

export const DONATE_TRANSLATIONS_READY = true;
