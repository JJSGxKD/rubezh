import { addTranslations } from "./index";
import run from "./ru-run.json";

/**
 * Тексты забега: HUD, пауза, выбор улучшения, характеристики, экран смерти.
 * Модуль импортируют файлы экрана забега — словарь дополняется, когда
 * подгружается их чанк, а первая загрузка за эти строки не платит
 * (docs/27-design-system-and-app-shell.md §3.4).
 */
addTranslations(run);

export const RUN_TRANSLATIONS_READY = true;
