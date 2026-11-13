import { Prisma } from "../../generated/prisma/client.js";
import { CONVERSION_WINDOWS } from "./conversion-rules.js";

/**
 * Что в запросах прохода считается засчитанным забегом (tasks/T-0071, docs/35-stage4-plan.md Р86, О39):
 * завершён, без читов, не короче `CONVERSION_WINDOWS.minRunSec`, вердикт не `rejected`. Условие одно на
 * регистрацию по клику, регистрацию по прямому запуску и возврат на следующий день — разойтись им нельзя:
 * игрок, у которого есть регистрация, обязан иметь и день регистрации.
 *
 * Фрагмент подставляется в `WHERE` запроса, где таблица `run` называется `alias`. Псевдоним в SQL идёт
 * готовым текстом, поэтому принимается только короткое имя из строчных латинских букв, а не любая строка.
 */
export function countedRun(alias: string): Prisma.Sql {
  if (!/^[a-z]{1,3}$/.test(alias)) throw new Error(`Недопустимый псевдоним таблицы run: ${alias}`);
  const run = Prisma.raw(alias);
  return Prisma.sql`(${run}.finished_at IS NOT NULL
        AND ${run}.cheats = false
        AND ${run}.survival_sec >= ${CONVERSION_WINDOWS.minRunSec}
        AND (${run}.verdict IS NULL OR ${run}.verdict <> 'rejected'))`;
}
