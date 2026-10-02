import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Шифрование ключей интеграций (docs/35-stage4-plan.md Р84, WP46):
 * AES-256-GCM, ключ шифрования — из окружения сервера.
 *
 * - **Своё случайное IV на каждую запись** — 12 байт, как велит GCM:
 *   повтор IV с тем же ключом раскрыл бы и текст, и подпись.
 * - **Имя ключа — в подписанных данных (AAD)**: шифртекст токена CoinGecko,
 *   переложенный в строку другого ключа, не расшифруется. Иначе тот, кто
 *   пишет в базу, но не знает ключа шифрования, мог бы подменить один секрет
 *   другим.
 * - **Отпечаток ключа шифрования** лежит рядом со шифртекстом: при смене
 *   ключа видно, чем зашифрована строка, и прежним ключом читается то, что
 *   ещё не записано заново. Отпечаток — хэш, а не часть ключа.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Запечатанное значение — как лежит в базе. */
export interface SealedSecret {
  /** отпечаток ключа шифрования, которым запечатано */
  keyId: string;
  iv: Uint8Array;
  authTag: Uint8Array;
  ciphertext: Uint8Array;
}

/** Строку не прочитать: ключ шифрования сменили без прежнего или строку испортили. */
export class SecretUnreadableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SecretUnreadableError";
  }
}

/** Отпечаток ключа шифрования: первые 12 знаков SHA-256 с приставкой — ключ по нему не восстановить. */
export function keyIdOf(key: Uint8Array): string {
  return createHash("sha256").update("rubezh:secrets:key-id:").update(key).digest("hex").slice(0, 12);
}

const aadOf = (name: string): Buffer => Buffer.from(`integration_secret:${name}`, "utf8");

export class SecretCipher {
  private readonly keys: readonly { id: string; key: Buffer }[];

  /** `encodedKeys` — base64, первый — текущий: им шифруется запись. */
  constructor(encodedKeys: readonly string[]) {
    if (encodedKeys.length === 0) throw new Error("SecretCipher без ключа шифрования");
    this.keys = encodedKeys.map((encoded) => {
      const key = Buffer.from(encoded, "base64");
      if (key.length !== 32) throw new Error("Ключ шифрования — 32 байта в base64");
      return { id: keyIdOf(key), key };
    });
  }

  /** Отпечаток текущего ключа: строки с другим перешифруются при следующей записи. */
  get currentKeyId(): string {
    return this.current().id;
  }

  seal(name: string, plain: string): SealedSecret {
    const { id, key } = this.current();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aadOf(name));
    const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return { keyId: id, iv, authTag: cipher.getAuthTag(), ciphertext };
  }

  open(name: string, sealed: SealedSecret): string {
    const entry = this.keys.find((candidate) => candidate.id === sealed.keyId);
    if (entry === undefined) throw new SecretUnreadableError("зашифровано ключом, которого нет в окружении");
    if (sealed.iv.length !== IV_BYTES || sealed.authTag.length !== TAG_BYTES) throw new SecretUnreadableError("строка испорчена");
    try {
      const decipher = createDecipheriv(ALGORITHM, entry.key, sealed.iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(aadOf(name));
      decipher.setAuthTag(sealed.authTag);
      return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
    } catch {
      // Подпись не сошлась: строку правили в обход панели или переложили из
      // другого ключа. Причина у GCM одна и та же — подробностей нет.
      throw new SecretUnreadableError("подпись шифртекста не сходится");
    }
  }

  private current(): { id: string; key: Buffer } {
    const first = this.keys[0];
    if (first === undefined) throw new Error("SecretCipher без ключа шифрования");
    return first;
  }
}
