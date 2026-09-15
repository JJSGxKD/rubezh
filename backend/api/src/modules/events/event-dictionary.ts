import { z } from "zod";

/**
 * Словарь событий на сервере (docs/22-analytics-and-metrics.md §3.3): имя,
 * версия структуры `payload` и её схема. Событие вне словаря не
 * записывается — иначе в базе заведутся `run_end`, `runFinished` и
 * `end_run` одновременно.
 *
 * Словарь живёт в бэкенде, а не в `shared-types`: собранный бэкенд не может
 * импортировать TypeScript-исходники пакетов монорепо. Расхождение со списком
 * клиента (`app-shell/src/state/analytics.ts`) и с таблицей документа ловит
 * `scripts/test/event-dictionary.test.ts`.
 *
 * `payload` клиента плоский — строки, числа, логические и `null`. Схема
 * требует известные поля и пропускает новые: клиент обновляется раньше
 * сервера, и новое поле не должно выбрасывать событие целиком. Изменение
 * смысла или типа поля — новая версия, а не правка на месте.
 */

const MAX_PAYLOAD_KEYS = 40;

const flatValue = z.union([z.string().max(512), z.number().finite(), z.boolean(), z.null()]);
const id = z.string().max(64);
const count = z.number().int().nonnegative();
const seconds = z.number().nonnegative();

function payload<Shape extends z.ZodRawShape>(shape: Shape) {
  return z
    .object(shape)
    .catchall(flatValue)
    .refine((value) => Object.keys(value).length <= MAX_PAYLOAD_KEYS, { message: "слишком много полей" });
}

const runOutcome = payload({
  seed: z.number().int(),
  survivalSec: seconds,
  level: count,
  wave: count,
  enemiesKilled: count,
  weapon: id,
  map: id,
  difficulty: id,
  contentHash: id,
  isNewRecord: z.boolean(),
  cheats: z.boolean(),
});

export const EVENT_DICTIONARY = {
  app_first_open: { version: 1, payload: payload({}) },
  screen_viewed: { version: 1, payload: payload({ screen: id, stub: z.boolean() }) },
  settings_changed: { version: 1, payload: payload({ setting: id, value: flatValue }) },
  share_offered: { version: 1, payload: payload({ context: id }) },
  share_completed: { version: 1, payload: payload({ context: id, result: id }) },
  run_started: {
    version: 1,
    payload: payload({
      seed: z.number().int(),
      weapon: id,
      map: id,
      difficulty: id,
      screenMode: id,
      orientation: id,
      devMode: z.boolean(),
    }),
  },
  run_resumed: { version: 1, payload: payload({ seed: z.number().int(), elapsedSec: seconds, level: count }) },
  run_finished: { version: 1, payload: runOutcome },
  run_abandoned: { version: 1, payload: runOutcome },
  run_paused: { version: 1, payload: payload({ reason: id, elapsedSec: seconds }) },
  upgrade_offered: { version: 1, payload: payload({ level: count, count, queued: count }) },
  upgrade_chosen: { version: 1, payload: payload({ option: id, level: count }) },
  wave_reached: { version: 1, payload: payload({ wave: count, elapsedSec: seconds }) },
  playtest_run_synced: { version: 1, payload: payload({ result: id, trigger: id }) },
  load_time: { version: 1, payload: payload({ phase: id, ms: seconds }) },
  diagnostics_mode_changed: { version: 1, payload: payload({ setting: id, value: z.boolean() }) },
  bench_finished: {
    version: 1,
    payload: payload({ mode: id, stopReason: id, peakObjects: count, verdict: id, reportId: z.uuid() }),
  },
  client_error: { version: 1, payload: payload({ scope: id, message: z.string().max(512) }) },
} as const;

export type EventType = keyof typeof EVENT_DICTIONARY;

export const EVENT_TYPES = Object.keys(EVENT_DICTIONARY) as EventType[];

export function isEventType(value: string): value is EventType {
  return Object.hasOwn(EVENT_DICTIONARY, value);
}
