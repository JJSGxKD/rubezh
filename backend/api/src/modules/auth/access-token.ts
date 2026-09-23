import { SignJWT, jwtVerify, errors } from "jose";
import { z } from "zod";

/**
 * Токен доступа: подписанный JWT, который проверяется без обращения к
 * хранилищу (docs/34-stage3-plan.md, WP1).
 *
 * **Что в нём лежит.** `sub` — идентификатор аккаунта, `platform` и
 * `platformUserId` — площадка и её идентификатор. Telegram ID ключом
 * идентичности не является нигде: аккаунты между площадками не связываются
 * (docs/08-web-and-identity.md §3), и завязать payload на Telegram — значит
 * растащить платформенную специфику по всему коду
 * (docs/13-reuse-from-vpnsibcom.md §4). Роли добавятся вместе с WP2; сейчас
 * их нет, и пустой список в токене только врал бы.
 *
 * **Почему `jose`, а не своя сборка JWT.** Формат простой, но ошибки в нём
 * дорогие: принятый `alg: none`, подмена алгоритма, разбор base64url без
 * выравнивания. Токен охраняет деньги, поэтому здесь берётся стандартная
 * библиотека без зависимостей, а не шестьдесят своих строк. Алгоритм при
 * проверке задаётся явно и из заголовка не читается.
 *
 * Полезная нагрузка — граница системы: она разбирается схемой, а не
 * приводится через `as`. Токен мог быть выпущен сборкой, которая клала туда
 * другое.
 */

export const TOKEN_ISSUER = "rubezh";
const ALGORITHM = "HS256";

export type AccountPlatform = "telegram" | "max" | "vk" | "web";

export interface AccessTokenClaims {
  accountId: string;
  platform: AccountPlatform;
  platformUserId: string;
}

const claimsSchema = z.object({
  sub: z.string().uuid(),
  platform: z.enum(["telegram", "max", "vk", "web"]),
  platformUserId: z.string().min(1).max(32),
});

/** Почему токен не принят. Клиент ветвится по причине: истёк — обновить, остальное — вход заново. */
export type AccessTokenCheck =
  | { ok: true; claims: AccessTokenClaims }
  | { ok: false; reason: "expired" | "invalid" };

export function secretKey(hexSecret: string): Uint8Array {
  return Buffer.from(hexSecret, "hex");
}

export async function signAccessToken(
  claims: AccessTokenClaims,
  secret: Uint8Array,
  ttlSec: number,
  nowMs: number,
): Promise<string> {
  const issuedAt = Math.floor(nowMs / 1000);
  return await new SignJWT({ platform: claims.platform, platformUserId: claims.platformUserId })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(claims.accountId)
    .setIssuer(TOKEN_ISSUER)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttlSec)
    .sign(secret);
}

export async function verifyAccessToken(token: string, secret: Uint8Array, nowMs: number): Promise<AccessTokenCheck> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: [ALGORITHM],
      issuer: TOKEN_ISSUER,
      currentDate: new Date(nowMs),
    });
    const parsed = claimsSchema.parse(payload);
    return {
      ok: true,
      claims: { accountId: parsed.sub, platform: parsed.platform, platformUserId: parsed.platformUserId },
    };
  } catch (error: unknown) {
    // Истёкший токен — штатное состояние: клиент обменяет его по токену
    // продления и не заметит. Всё остальное — повод войти заново.
    if (error instanceof errors.JWTExpired) return { ok: false, reason: "expired" };
    return { ok: false, reason: "invalid" };
  }
}
