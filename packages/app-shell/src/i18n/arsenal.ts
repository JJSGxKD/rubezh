import { addTranslations } from "./index";
import arsenal from "./ru-arsenal.json";

/**
 * Тексты арсенала: слоты, редкости, свойства предметов и операции над ними.
 * Модуль импортирует экран арсенала — словарь дополняется, когда подгружается
 * его чанк, а первая загрузка их не несёт
 * (docs/27-design-system-and-app-shell.md §3.4).
 */
addTranslations(arsenal);

export const ARSENAL_TRANSLATIONS_READY = true;
