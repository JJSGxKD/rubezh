import { SOURCE_TYPES, sourceProblem } from "../ui/image-crop";

/**
 * Картинки, которые человек приносит в редактор: «своё фото» партнёра и
 * загрузка команды. Проверка до того, как файл попадёт на холст: только
 * растровые PNG, JPEG и WebP, и не больше предела панели. SVG не берём вовсе:
 * в нём бывают скрипты, а редактору растр нужен не меньше векторного.
 */
export const PHOTO_TYPES = SOURCE_TYPES;

/** Что не так с файлом; `null` — можно открывать. Тип смотрим по заявленному браузером. */
export function photoProblem(file: { type: string; size: number }): string | null {
  return sourceProblem(file);
}

/** Значение `accept` для окна выбора файла. */
export const PHOTO_ACCEPT = PHOTO_TYPES.join(",");
