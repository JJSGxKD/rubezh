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

const amount = z.number().nonnegative();
const ratio = z.number().min(0).max(1);

// Покупка глазами клиента (docs/34-stage3-plan.md, WP5): воронка от нажатия до
// продолжения. Суммы здесь — разрез, а не выручка: выручку и возвраты
// считают по таблице `purchase` (docs/22-analytics-and-metrics.md §5.4).
// Режим обязателен: тестовые оплаты не должны смешиваться с настоящими.
const purchaseFields = {
  product: id,
  priceStars: count,
  chargedStars: count,
  mode: z.enum(["live", "test"]),
  continueNo: count,
};

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
  // Сводка производительности (docs/28-diagnostics.md §3.2). Необязательная:
  // сборки до неё её не шлют, а смысл остальных полей она не меняет.
  perfFrames: count.optional(),
  perfAvgFps: amount.optional(),
  perfP95FrameMs: amount.optional(),
  perfOver33Ratio: ratio.optional(),
  perfPeakObjects: count.optional(),
  perfDisplayHz: count.optional(),
  perfRenderCapFps: count.nullable().optional(),
  perfRenderer: z.enum(["webgl", "canvas"]).optional(),
  perfDpr: z.number().positive().max(10).optional(),
  perfCanvasWidth: count.optional(),
  perfCanvasHeight: count.optional(),
  perfInterruptions: count.optional(),
});

export const EVENT_DICTIONARY = {
  app_first_open: { version: 1, payload: payload({}) },
  // Аккаунт заведён — ровно один раз за его жизнь: о том, что вход был
  // первым, знает только сервер (docs/34-stage3-plan.md, WP1).
  user_registered: { version: 1, payload: payload({}) },
  // Как игрок получил сессию: `launch` — вход на запуске, `refresh` —
  // плановое продление, `reauth` — сервер не принял токен посреди работы.
  // Доля `reauth` показывает, часто ли сессии теряются на самом деле.
  user_authenticated: { version: 1, payload: payload({ reason: z.enum(["launch", "refresh", "reauth"]) }) },
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
  // Второй шанс взят (docs/07-monetization-and-ads.md §8): откуда — `dev`
  // (бесплатно в забеге разработчика), `premium` (за Stars), позже `ad`;
  // на какой секунде и волне забега.
  continue_used: { version: 1, payload: payload({ source: id, elapsedSec: seconds, wave: count }) },
  // Нажал «продолжить за звёзды» — счёт запрошен.
  purchase_initiated: { version: 1, payload: payload(purchaseFields) },
  // Сервер подтвердил оплату, продолжение выдано.
  purchase_completed: { version: 1, payload: payload(purchaseFields) },
  // Не дошло до продолжения: `reason` — `cancelled` (закрыл окно), `failed`,
  // `unsupported`, `timeout` (подтверждение не дождались) или код отказа сервера.
  purchase_failed: { version: 1, payload: payload({ ...purchaseFields, reason: id }) },
  // Дошёл ли старт или итог забега до сервера (docs/34-stage3-plan.md, WP4).
  // По старту видно, какая доля честных забегов теряет проверку времени —
  // вход для решения О5; по итогу — вердикт антифрода.
  run_synced: {
    version: 1,
    payload: payload({
      kind: z.enum(["start", "finish"]),
      result: z.enum(["sent", "queued", "dropped"]),
      trigger: id,
    }),
  },
  load_time: { version: 1, payload: payload({ phase: id, ms: seconds }) },
  diagnostics_mode_changed: { version: 1, payload: payload({ setting: id, value: z.boolean() }) },
  bench_finished: {
    version: 1,
    payload: payload({ mode: id, stopReason: id, peakObjects: count, verdict: id, reportId: z.uuid() }),
  },
  feedback_sent: { version: 1, payload: payload({ answers: count, hasText: z.boolean(), runs: count }) },
  client_error: { version: 1, payload: payload({ scope: id, message: z.string().max(512) }) },
} as const;

export type EventType = keyof typeof EVENT_DICTIONARY;

export const EVENT_TYPES = Object.keys(EVENT_DICTIONARY) as EventType[];

export function isEventType(value: string): value is EventType {
  return Object.hasOwn(EVENT_DICTIONARY, value);
}
