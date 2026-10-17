import { addTranslations } from "./index";
import tester from "./ru-tester.json";

/**
 * Тексты окна «Спасибо за тест» (docs/35-stage4-plan.md Р87) — своим словарём:
 * окно видят тестеры один раз после вайпа, первая загрузка за него не платит
 * (docs/27-design-system-and-app-shell.md §3.4). Слово «Тестер» для знака
 * лежит в основном словаре — знак виден на трёх экранах.
 */
addTranslations(tester);

export const TESTER_TRANSLATIONS_READY = true;
