import { addTranslations } from "./index";
import team from "./ru-team.json";

/**
 * Тексты инструментов команды. Модуль импортируют экраны, которые их
 * показывают: словарь дополняется в момент загрузки их чанка, до первой
 * отрисовки.
 */
addTranslations(team);

export const TEAM_TRANSLATIONS_READY = true;
