import { createHash } from "node:crypto";

/**
 * JSON с ключами по порядку на всех уровнях. Postgres хранит `jsonb` с другим
 * порядком ключей, чем в записанном объекте, а отпечаток снимка обязан не
 * зависеть от того, прошёл ли он через базу.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sorted(value)) ?? "null";
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  // `fromEntries`, а не присваивание по ключу: присваивание `__proto__` меняло бы прототип, а не поле.
  return Object.fromEntries(Object.keys(source).sort().map((key) => [key, sorted(source[key])]));
}

/**
 * Отпечаток снимка для проверок: sha256 канонического JSON. Это не
 * `content_hash` версии (его считает движок и кладёт выгрузка, docs/19 §3):
 * черновик — любой снимок, который человек успел набрать, и движок за ним не
 * ходит. Здесь нужно одно — узнать, поменялся ли снимок с прошлой проверки.
 */
export function snapshotHash(snapshot: unknown): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}
