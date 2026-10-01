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

// Покупка глазами клиента (docs/34-stage3-plan.md, WP5; магазин и VIP —
// docs/35-stage4-plan.md, WP10): воронка от нажатия до выдачи. Суммы здесь —
// разрез, а не выручка: выручку и возвраты считают по таблице `purchase`
// (docs/22-analytics-and-metrics.md §5.4). Режим обязателен: тестовые оплаты
// не должны смешиваться с настоящими. Номер продолжения — только у второго
// шанса, товар — только у магазина; поля необязательные, версия прежняя.
const purchaseFields = {
  product: id,
  priceStars: count,
  chargedStars: count,
  mode: z.enum(["live", "test"]),
  continueNo: count.optional(),
  sku: id.optional(),
  // Скидка акции магазина в процентах — только у товара по акции (WP10, часть 8).
  promoPct: count.optional(),
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
  // Урон по стихиям (docs/35-stage4-plan.md, WP6), округлённый до целого.
  // Необязательный: сборки до стихий его не шлют.
  damagePhysical: count.optional(),
  damageFire: count.optional(),
  damageCold: count.optional(),
  damageLightning: count.optional(),
  damagePoison: count.optional(),
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
  // Запуск игры со снимком атрибуции (docs/34-stage3-plan.md, WP6): откуда
  // открыли — по подписи, которую проверил сервер; `first` — аккаунт заведён
  // этим запуском. Сама сессия с подробностями — в таблице `account_session`.
  session_started: { version: 1, payload: payload({ startKind: id, first: z.boolean() }) },
  screen_viewed: { version: 1, payload: payload({ screen: id, stub: z.boolean() }) },
  // `scope` — чья настройка (docs/35-stage4-plan.md WP29): аккаунта идёт на
  // все его устройства, устройства остаётся здесь. Необязательное: сборки до
  // настроек аккаунта его не шлют.
  settings_changed: { version: 1, payload: payload({ setting: id, value: flatValue, scope: z.enum(["account", "device"]).optional() }) },
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
  // Сервер подтвердил покупку буста на забег (WP8): по событию на буст.
  boost_used: { version: 1, payload: payload({ boost: id, source: id, amount, count }) },
  // Нажал «продолжить за звёзды» — счёт запрошен; в магазине — счёт выставлен.
  purchase_initiated: { version: 1, payload: payload(purchaseFields) },
  // Сервер подтвердил оплату: продолжение выдано, товар лёг на счёт.
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
  feedback_sent: { version: 1, payload: payload({ answers: count, hasText: z.boolean(), runs: count, kind: z.enum(["device_info"]).optional() }) },
  // Игрок открыл уведомление из ленты — перешёл туда, куда оно звало
  // (docs/35-stage4-plan.md WP28). Вид — низкой кардинальности, без данных.
  notification_opened: { version: 1, payload: payload({ kind: id }) },
  // Забрал награду дня (docs/35-stage4-plan.md WP13): какой день недели и
  // какая по счёту неделя — удерживает ли награда. Сколько легло монет —
  // журнал кошелька, причина daily_reward.
  daily_reward_claimed: { version: 1, payload: payload({ day: count, week: count }) },
  // Крутанул колесо (docs/35-stage4-plan.md WP13, 07-monetization-and-ads.md
  // §7): бесплатная крутка или за рекламу, какой сектор выпал и что в нём.
  // Что легло на баланс — журнал кошелька, причина wheel_reward.
  wheel_spun: { version: 1, payload: payload({ source: z.enum(["free", "ad"]), sector: count, reward: id, amount: count }) },
  // Забрал награду задания или достижения (docs/35-stage4-plan.md WP13): какие
  // цели доходят до награды и за какой срок. Прогресс и забор — таблица
  // task_progress, начисленное — журнал кошелька (task_reward,
  // achievement_reward); событие шлёт клиент после ответа сервера.
  task_completed: { version: 1, payload: payload({ task: id, period: z.enum(["daily", "weekly"]), kind: id }) },
  achievement_unlocked: { version: 1, payload: payload({ achievement: id, kind: id }) },
  // Открыл ссылку цели — канал проекта (docs/35-stage4-plan.md Р52): сколько
  // открывших доходят до награды. Подписку проверяет бот, и она видна только
  // по achievement_unlocked; открытие без награды — «не подписался».
  task_link_opened: { version: 1, payload: payload({ task: id, kind: id }) },
  // Купил предмет с витрины снаряжения (docs/35-stage4-plan.md §3.6, WP10):
  // какие редкости и слоты берут и за сколько — вход для цен витрины (О1, О9).
  // Списание — журнал кошелька (причина shop), предмет — журнал предметов.
  showcase_bought: { version: 1, payload: payload({ slot: id, rarity: id, level: count, gems: count }) },
  // Нажал баннер или плашку магазина (docs/35-stage4-plan.md §3.6, WP10):
  // какой баннер и на каком месте полосы ведёт к покупке — вход для порядка
  // баннеров. Сама покупка — purchase_initiated / purchase_completed с тем же
  // товаром; у Tribute и снаряжения покупка не наша или за самоцветы, и клик
  // — всё, что видно.
  shop_banner_clicked: {
    version: 1,
    payload: payload({ banner: id, place: z.enum(["carousel", "gems"]), position: count }),
  },
  // Принял предупреждение об открытом тесте (docs/35-stage4-plan.md WP33):
  // доходят ли новички до игры после него и с какой версии текста. Само
  // принятие — таблица test_notice, по ней проверяется, что игрок видел
  // предупреждение до первой покупки.
  test_notice_accepted: { version: 1, payload: payload({ version: count }) },
  // Открыл журнал обновлений (docs/35-stage4-plan.md WP31): доходят ли игроки
  // до него после выхода версии и откуда — из меню или из уведомления. Сколько
  // версий было новыми — чтобы отличить «пришёл за новостью» от «просто листал».
  changelog_opened: { version: 1, payload: payload({ fresh: count, source: z.enum(["menu", "notification"]) }) },
  client_error: { version: 1, payload: payload({ scope: id, message: z.string().max(512) }) },
} as const;

export type EventType = keyof typeof EVENT_DICTIONARY;

export const EVENT_TYPES = Object.keys(EVENT_DICTIONARY) as EventType[];

export function isEventType(value: string): value is EventType {
  return Object.hasOwn(EVENT_DICTIONARY, value);
}
