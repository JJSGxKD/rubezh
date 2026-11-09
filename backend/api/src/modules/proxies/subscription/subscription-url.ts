import { SecretUnreadableError, type SecretCipher } from "../../secrets/secret-cipher.js";

/**
 * Адрес подписки — секрет целиком (токен бывает и в пути, и в query): в базе он
 * лежит только шифртекстом того же `SecretCipher`, что и ключи интеграций
 * (docs/35-stage4-plan.md Р84, Р101). Имя шифртекста — `proxy_subscription:<ключ>`:
 * оно подписано вместе с данными, и адрес, переложенный в другую строку, не
 * расшифруется.
 */

/** Колонки адреса в `proxy_subscription`. */
export interface UrlColumns {
  urlIv: Uint8Array;
  urlTag: Uint8Array;
  urlCt: Uint8Array;
  urlKeyId: string;
  /** «хост …abcd»: чтобы человек сверил адрес с кабинетом поставщика, не видя его */
  urlHint: string;
}

const HINT_HOST_MAX = 60;
const HINT_TAIL = 4;

export const subscriptionSecretName = (key: string): string => `proxy_subscription:${key}`;

/** Хост и последние знаки адреса. Хвост — единственное, что из секрета попадает в видимое место. */
export function urlHintOf(url: string): string {
  const host = URL.canParse(url) ? new URL(url).hostname : "адрес";
  return `${host.slice(0, HINT_HOST_MAX)} …${url.slice(-HINT_TAIL)}`;
}

export function sealUrl(cipher: SecretCipher, key: string, url: string): UrlColumns {
  const sealed = cipher.seal(subscriptionSecretName(key), url);
  return { urlIv: sealed.iv, urlTag: sealed.authTag, urlCt: sealed.ciphertext, urlKeyId: sealed.keyId, urlHint: urlHintOf(url) };
}

/** Адрес открытым текстом; не читается (другой ключ, испорченная строка) — `SecretUnreadableError`. */
export function openUrl(cipher: SecretCipher, row: UrlColumns & { key: string }): string {
  if (row.urlCt.length === 0) throw new SecretUnreadableError("адрес подписки пуст");
  return cipher.open(subscriptionSecretName(row.key), { keyId: row.urlKeyId, iv: row.urlIv, authTag: row.urlTag, ciphertext: row.urlCt });
}
