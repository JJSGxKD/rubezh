import { renderPng } from "../../common/card/svg.js";
import { APP_ICON_SVG } from "../../common/card/brand-art.js";

/**
 * Фото профиля бота — значок приложения v2: руна Ж с ромбом-оберегом на
 * сумеречном небе с частоколом (`design/art/src/logo.mjs`,
 * design/art/direction-v2.md §7.1). Квадрат без скругления: Telegram сам
 * обрезает фото профиля кругом, и кольцо-печать вокруг руны в круг
 * вписывается. Рисуется тем же resvg, что карточки: фото меняется правкой
 * знака, без ручной загрузки в BotFather.
 */
const SIZE = 1024;

export const BOT_AVATAR_SVG = APP_ICON_SVG.replace('viewBox="0 0 512 512"', `width="${String(SIZE)}" height="${String(SIZE)}" viewBox="0 0 512 512"`);

export function renderBotAvatar(): Buffer {
  return renderPng(BOT_AVATAR_SVG);
}
