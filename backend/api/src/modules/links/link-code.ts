import { randomInt } from "node:crypto";

/**
 * Коды ссылок и кликов (docs/24-attribution-and-sharing.md §3.1): случайные,
 * не инкрементальные — перебором чужие ссылки не просканировать и чужие
 * клики не накрутить — и без данных внутри: это ключ к строке, а не упаковка.
 * Без похожих знаков (0/O, 1/l/I): код бывает, что переписывают руками.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function randomCode(length: number): string {
  let code = "";
  for (let index = 0; index < length; index++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** Код ссылки кампании: `/r/<код>`. */
export function newLinkCode(): string {
  return randomCode(10);
}

/** Код клика: уходит в параметр запуска `c-<код>` (6–32 знака, `attribution/start-param.ts`). */
export function newClickId(): string {
  return randomCode(12);
}

export const LINK_CODE = /^[A-Za-z0-9]{6,16}$/;
