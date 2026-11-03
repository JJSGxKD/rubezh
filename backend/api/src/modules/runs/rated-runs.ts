import { RATED_DIFFICULTIES, isRatedDifficulty, type Difficulty } from "./run-rules.js";

/**
 * Какие забеги считает рейтинг (Р126, tasks/T-0191): единая сложность, и
 * закончен забег не раньше отсечки `rating.since-date`. Одно правило для
 * живой проекции, пересборки из базы, сезонов и модерации — поэтому живёт в
 * файле без Nest и Prisma-клиента: его читают и сервисы, и запросы, и тесты.
 *
 * Отсечка — по `finished_at`, как окно недели сезона: забег, начатый до неё и
 * законченный после, считается.
 */

/** Год короче четырёх знаков — не дата: `Date.UTC` читает 0–99 как 1900–1999. */
const YEAR_MIN = 1000;

/**
 * Значение настройки `rating.since-date` (ГГГГММДД, например `20261026`) в
 * начало суток UTC. `0`, дробь, отрицательное и несуществующая дата — `null`:
 * отсечки нет.
 */
export function ratingSinceOf(value: number): Date | null {
  if (!Number.isInteger(value) || value <= 0) return null;
  const year = Math.floor(value / 10_000);
  const month = Math.floor(value / 100) % 100;
  const day = value % 100;
  if (year < YEAR_MIN || year > 9999) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

/** Идёт ли забег в рейтинг: рейтинговая сложность и (отсечки нет или забег закончен не раньше неё). */
export function isRatedRun(difficulty: Difficulty, finishedAt: Date, since: Date | null): boolean {
  return isRatedDifficulty(difficulty) && (since === null || finishedAt.getTime() >= since.getTime());
}

/**
 * Условие для `where` запросов к таблице `run`: то же правило, что
 * `isRatedRun`. Вызывающий добавляет своё — `ranked`, аккаунт, статус; для
 * одной сложности — ещё и `difficulty`, но только рейтинговой (нерейтинговую
 * запрос не делает вовсе).
 */
export function ratedWhere(since: Date | null): { difficulty: { in: Difficulty[] }; finishedAt?: { gte: Date } } {
  return { difficulty: { in: [...RATED_DIFFICULTIES] }, ...(since === null ? {} : { finishedAt: { gte: since } }) };
}
