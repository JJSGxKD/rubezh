import { addTranslations } from "./index";
import gallery from "./ru-gallery.json";

/**
 * Тексты витрины компонентов — внутри её чанка: витрину открывает только
 * команда, и платить за её подписи не должны ни первая загрузка игрока, ни
 * экраны, которые видят тестеры («Диагностика» грузит словарь команды).
 * Название витрины — в словаре команды: по нему «Диагностика» показывает пункт.
 */
addTranslations(gallery);

export const GALLERY_TRANSLATIONS_READY = true;
