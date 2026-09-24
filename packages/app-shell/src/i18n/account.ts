import { addTranslations } from "./index";
import account from "./ru-account.json";

/**
 * Тексты об аккаунте и состоянии входа — для профиля и рейтинга. Модуль
 * импортируют их экраны: словарь дополняется, когда подгружается их чанк.
 *
 * Отдельно от основного словаря: у первой загрузки запаса меньше килобайта
 * (docs/27-design-system-and-app-shell.md §3.4), а эти строки нужны только
 * тому, кто открыл профиль или рейтинг.
 */
addTranslations(account);

export const ACCOUNT_TRANSLATIONS_READY = true;
