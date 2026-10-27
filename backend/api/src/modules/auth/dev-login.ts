/**
 * Вход разработчика без Telegram — `dev-<id>:Имя`, только при
 * `AUTH_DEV_LOGIN=true`, а тот допустим только в development
 * (docs/20-env-and-ports.md §8).
 *
 * Префикс `dev-` не бывает у настоящего Telegram ID — они числовые, — поэтому
 * аккаунт разработчика не совпадёт ни с одним игроком, даже если оба
 * окажутся в одной базе.
 */

const DEV_ID = /^dev-[a-z0-9-]{1,32}$/;
const DEFAULT_NAME = "Разработчик";
const MAX_NAME_LENGTH = 64;

export interface DevUser {
  platformUserId: string;
  displayName: string;
}

/** `null` — строка не похожа на вход разработчика: такой вход не принимается вовсе. */
export function parseDevUser(value: string): DevUser | null {
  const [id = "", ...rest] = value.split(":");
  if (!DEV_ID.test(id)) return null;
  const name = rest.join(":").trim().slice(0, MAX_NAME_LENGTH);
  return { platformUserId: id, displayName: name === "" ? DEFAULT_NAME : name };
}

export function isDeveloperAccount(account: { platform: string; platformUserId: string }): boolean {
  return account.platform === "telegram" && DEV_ID.test(account.platformUserId);
}

/** Вход `dev-player-<id>` — разработчик в роли обычного игрока: автоматической роли владельца нет. */
const PLAYER_PREFIX = "dev-player-";

/**
 * Получает ли аккаунт разработчика роль владельца автоматически. `dev-player-<id>`
 * — нет: так игру видно глазами игрока, без вкладок режимов и инструментов
 * команды; роли у него только те, что выданы в базе.
 */
export function isDeveloperOwner(account: { platform: string; platformUserId: string }): boolean {
  return isDeveloperAccount(account) && !account.platformUserId.startsWith(PLAYER_PREFIX);
}
