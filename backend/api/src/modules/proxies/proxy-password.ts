import { SecretUnreadableError, type SecretCipher } from "../secrets/secret-cipher.js";

/**
 * Пароль прокси — только шифртекстом тем же `SecretCipher`, что и ключи
 * интеграций (docs/35-stage4-plan.md Р84, Р91). Имя шифртекста — `proxy:<id>`:
 * оно подписано вместе с данными, и пароль одного прокси, переложенный в
 * строку другого, не расшифруется.
 */

/** Шифр прокси; `null` — нет ключа шифрования или базы: пароль не сохранить и не прочитать. */
export const PROXY_CIPHER = Symbol("PROXY_CIPHER");

export const proxySecretName = (proxyId: string): string => `proxy:${proxyId}`;

/** Колонки пароля в `outbound_proxy`: заполнены все или ни одна. */
export interface PasswordColumns {
  passwordIv: Uint8Array;
  passwordTag: Uint8Array;
  passwordCt: Uint8Array;
  passwordKeyId: string;
}

export interface PasswordRow {
  proxyId: string;
  passwordIv: Uint8Array | null;
  passwordTag: Uint8Array | null;
  passwordCt: Uint8Array | null;
  passwordKeyId: string | null;
}

export const NO_PASSWORD = { passwordIv: null, passwordTag: null, passwordCt: null, passwordKeyId: null } as const;

export function hasPassword(row: PasswordRow): boolean {
  return row.passwordCt !== null;
}

export function sealPassword(cipher: SecretCipher, proxyId: string, plain: string): PasswordColumns {
  const sealed = cipher.seal(proxySecretName(proxyId), plain);
  return { passwordIv: sealed.iv, passwordTag: sealed.authTag, passwordCt: sealed.ciphertext, passwordKeyId: sealed.keyId };
}

/** Пароль открытым текстом; `null` — пароля нет. Не читается — `SecretUnreadableError`. */
export function openPassword(cipher: SecretCipher, row: PasswordRow): string | null {
  if (row.passwordIv === null || row.passwordTag === null || row.passwordCt === null || row.passwordKeyId === null) return null;
  return cipher.open(proxySecretName(row.proxyId), { keyId: row.passwordKeyId, iv: row.passwordIv, authTag: row.passwordTag, ciphertext: row.passwordCt });
}

/** Читается ли пароль этим шифром. Нет пароля — читать нечего, значит читается. */
export function isReadable(cipher: SecretCipher | null, row: PasswordRow): boolean {
  if (!hasPassword(row)) return true;
  if (cipher === null) return false;
  try {
    openPassword(cipher, row);
    return true;
  } catch (error: unknown) {
    if (error instanceof SecretUnreadableError) return false;
    throw error;
  }
}
