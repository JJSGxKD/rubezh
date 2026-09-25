import { randomInt } from "node:crypto";

/**
 * Код ссылки дружбы: `f-<код>` в параметре запуска (docs/24-attribution-and-sharing.md
 * §3.1). Код — ключ к строке `friend_link`, а не данные: из него не узнать ни
 * аккаунт, ни Telegram ID. Двенадцать знаков из пятидесяти семи — около 10²¹
 * вариантов: перебором чужую ссылку не найти.
 *
 * Без похожих знаков (0/O, 1/l/I): код бывает, что диктуют голосом.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
export const FRIEND_CODE_LENGTH = 12;

export function newFriendCode(): string {
  let code = "";
  for (let index = 0; index < FRIEND_CODE_LENGTH; index++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** Параметр запуска Mini App: его разбирает `attribution/start-param.ts`. */
export function friendStartParam(code: string): string {
  return `f-${code}`;
}
