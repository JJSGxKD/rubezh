import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { ItemStat } from "./item-catalog.js";

/**
 * Подписанный снимок надетого (Р17, docs/35-stage4-plan.md §3.4): клиент
 * получает его, когда надетое меняется, и подаёт на старте забега — в том
 * числе без сети. Сервер по подписи узнаёт свой снимок и не верит набору,
 * который клиент собрал сам.
 *
 * Ключ подписи выводится из секрета сессий (HKDF с собственной меткой), а не
 * заводится отдельной переменной: у него та же область доверия, а метка не
 * даёт подписи снимка и токена сессии совпасть.
 */

export interface LoadoutSnapshot {
  accountId: string;
  modifiers: Partial<Record<ItemStat, number>>;
  /** UTC, миллисекунды */
  issuedAtMs: number;
  signature: string;
}

const SIGNING_LABEL = "rubezh:loadout-snapshot:v1";

export function loadoutKey(sessionSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", sessionSecret, Buffer.alloc(0), SIGNING_LABEL, 32));
}

/**
 * Каноническая строка: ключи параметров по алфавиту. Одинаковый набор обязан
 * давать одну подпись, в каком бы порядке его ни собрали.
 */
function canonical(accountId: string, modifiers: Partial<Record<ItemStat, number>>, issuedAtMs: number): string {
  const sorted = Object.keys(modifiers)
    .sort()
    .map((stat) => [stat, modifiers[stat as ItemStat]]);
  return JSON.stringify([accountId, sorted, issuedAtMs]);
}

export function signLoadout(key: Buffer, accountId: string, modifiers: Partial<Record<ItemStat, number>>, issuedAtMs: number): LoadoutSnapshot {
  const signature = createHmac("sha256", key).update(canonical(accountId, modifiers, issuedAtMs)).digest("base64url");
  return { accountId, modifiers, issuedAtMs, signature };
}

/** Снимок подписан этим сервером и не тронут. Сравнение — за постоянное время. */
export function verifyLoadout(key: Buffer, snapshot: LoadoutSnapshot): boolean {
  const expected = createHmac("sha256", key).update(canonical(snapshot.accountId, snapshot.modifiers, snapshot.issuedAtMs)).digest();
  const given = Buffer.from(snapshot.signature, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
