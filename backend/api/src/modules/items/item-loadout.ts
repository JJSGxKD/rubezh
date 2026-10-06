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
 *
 * Снимок несёт и уровень аккаунта (WP25): от него движок открывает оружие,
 * навыки и слоты. Уровень входит в подпись; снимок прошлой сборки без уровня
 * подписан прежней строкой и проверяется ею же — снять уровень с нового
 * снимка или дописать его в старый подпись не даст.
 */

export interface LoadoutSnapshot {
  accountId: string;
  modifiers: Partial<Record<ItemStat, number>>;
  accountLevel: number;
  /** UTC, миллисекунды */
  issuedAtMs: number;
  signature: string;
}

const SIGNING_LABEL = "rubezh:loadout-snapshot:v1";

export function loadoutKey(sessionSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", sessionSecret, Buffer.alloc(0), SIGNING_LABEL, 32));
}

/** Снимок, как он вернулся от клиента: параметры — какие угодно, решает подпись. */
export interface ClaimedLoadout {
  accountId: string;
  modifiers: Readonly<Record<string, number | undefined>>;
  /** нет поля — снимок прошлой сборки */
  accountLevel?: number | undefined;
  issuedAtMs: number;
  signature: string;
}

/**
 * Параметры по алфавиту. Одинаковый набор обязан давать одну подпись и
 * считаться тем же набором, в каком бы порядке его ни собрали.
 */
function sortedModifiers(modifiers: Readonly<Record<string, number | undefined>>): [string, number | undefined][] {
  return Object.keys(modifiers)
    .sort()
    .map((stat) => [stat, modifiers[stat]]);
}

function canonical(accountId: string, modifiers: Readonly<Record<string, number | undefined>>, issuedAtMs: number, accountLevel: number | undefined): string {
  if (accountLevel === undefined) return JSON.stringify([accountId, sortedModifiers(modifiers), issuedAtMs]);
  return JSON.stringify([accountId, sortedModifiers(modifiers), issuedAtMs, accountLevel]);
}

/** Тот же набор параметров — значения сравниваются точно: оба посчитаны одной функцией. */
export function sameModifiers(a: Readonly<Record<string, number | undefined>>, b: Readonly<Record<string, number | undefined>>): boolean {
  return JSON.stringify(sortedModifiers(a)) === JSON.stringify(sortedModifiers(b));
}

export function signLoadout(key: Buffer, accountId: string, modifiers: Partial<Record<ItemStat, number>>, accountLevel: number, issuedAtMs: number): LoadoutSnapshot {
  const signature = createHmac("sha256", key).update(canonical(accountId, modifiers, issuedAtMs, accountLevel)).digest("base64url");
  return { accountId, modifiers, accountLevel, issuedAtMs, signature };
}

/** Снимок подписан этим сервером и не тронут. Сравнение — за постоянное время. */
export function verifyLoadout(key: Buffer, snapshot: ClaimedLoadout): boolean {
  const expected = createHmac("sha256", key).update(canonical(snapshot.accountId, snapshot.modifiers, snapshot.issuedAtMs, snapshot.accountLevel)).digest();
  const given = Buffer.from(snapshot.signature, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
