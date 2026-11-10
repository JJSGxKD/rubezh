import { z } from "zod";
import raw from "./expected-runs.json" with { type: "json" };

/**
 * Таблица ожидаемого `E(S, t)` для очков эффективности (tasks/T-0291, T-0293,
 * Р152): по полосе силы и минуте забега — медианы прогонов бота калибровки.
 * Сервер не гоняет симуляцию на каждый забег, а берёт число отсюда.
 *
 * Файл собирает `pnpm balance:expected`; сервер пакеты игры не импортирует,
 * поэтому таблица едет файлом, а форму проверяет эта схема: битый файл не
 * должен молча превратиться в нули.
 */

/** Сколько минут в таблице: дальше двадцатой берётся двадцатая. */
export const TABLE_MINUTES = 20;

const finite = z.number().finite().nonnegative();

const bandSchema = z.object({
  id: z.string().min(1).max(16),
  fromPower: z.number().finite().nonnegative(),
  // Последняя полоса открыта сверху.
  toPower: z.number().finite().positive().nullable(),
});

const rowSchema = z.object({
  band: z.string().min(1).max(16),
  minute: z.number().int().min(1).max(TABLE_MINUTES),
  killsPerMin: finite,
  huntPerMin: finite,
  huntKillSec: z.object({ elite: finite, boss: finite }),
  damageTakenPerMin: finite,
  buildScore: finite,
});

export const expectedTableSchema = z
  .object({
    version: z.number().int().positive(),
    contentHash: z.string().min(1).max(32),
    generatedAt: z.string().min(1),
    bands: z.array(bandSchema).min(1),
    rows: z.array(rowSchema).min(1),
  })
  .superRefine((table, context) => {
    // Полосы идут по возрастанию силы, а первая начинается с нуля: иначе слабая сила не попадёт ни в одну.
    table.bands.forEach((band, index) => {
      const previous = table.bands[index - 1];
      if (index === 0 && band.fromPower !== 0) context.addIssue({ code: "custom", message: "первая полоса начинается с нуля", path: ["bands", index, "fromPower"] });
      if (previous !== undefined && band.fromPower <= previous.fromPower) context.addIssue({ code: "custom", message: "полосы идут по возрастанию силы", path: ["bands", index, "fromPower"] });
    });
    // Каждой полосе — свои двадцать минут: пустая клетка не должна тихо взять чужую строку.
    for (const band of table.bands) {
      const minutes = new Set(table.rows.filter((row) => row.band === band.id).map((row) => row.minute));
      if (minutes.size !== TABLE_MINUTES) context.addIssue({ code: "custom", message: `у полосы ${band.id} не все минуты`, path: ["rows"] });
    }
  });

export type ExpectedTable = z.infer<typeof expectedTableSchema>;
export type ExpectedBand = ExpectedTable["bands"][number];
export type ExpectedRow = ExpectedTable["rows"][number];

/** Полоса по силе игрока на старте; нет силы — средняя (подстройки не было). */
export function bandOf(table: ExpectedTable, power: number | null): ExpectedBand {
  if (power === null) return table.bands[Math.floor((table.bands.length - 1) / 2)] ?? firstBand(table);
  let found = firstBand(table);
  for (const band of table.bands) {
    if (power >= band.fromPower) found = band;
  }
  return found;
}

function firstBand(table: ExpectedTable): ExpectedBand {
  const first = table.bands[0];
  if (first === undefined) throw new Error("в таблице ожидаемого нет полос");
  return first;
}

/** Строка полосы и минуты; минута вне 1…20 берётся с ближайшего края. */
export function expectedRowOf(table: ExpectedTable, bandId: string, minute: number): ExpectedRow {
  const wanted = Math.min(TABLE_MINUTES, Math.max(1, Math.trunc(minute)));
  const row = table.rows.find((candidate) => candidate.band === bandId && candidate.minute === wanted);
  if (row === undefined) throw new Error(`в таблице ожидаемого нет строки ${bandId}/${String(wanted)}`);
  return row;
}

/** Откуда сервис берёт таблицу; `null` — таблица не загрузилась, очков не будет. */
export interface ExpectedTableSource {
  get(): ExpectedTable | null;
}

export const EXPECTED_TABLE_SOURCE = Symbol("EXPECTED_TABLE_SOURCE");

/** Таблица из файла рядом с кодом: разбирается один раз, битый файл — `null` и сообщение в лог вызывающего. */
export function bundledExpectedTable(): ExpectedTable | null {
  const parsed = expectedTableSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Источник из файла: разбор — при первом обращении, не при загрузке модуля, чтобы битый файл не ронял запуск. */
export class BundledExpectedTable implements ExpectedTableSource {
  private table: ExpectedTable | null | undefined;

  get(): ExpectedTable | null {
    if (this.table === undefined) this.table = bundledExpectedTable();
    return this.table;
  }
}
