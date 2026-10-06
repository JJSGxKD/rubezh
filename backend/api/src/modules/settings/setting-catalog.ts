import { z } from "zod";
import type { AppConfig } from "../../config/app-config.js";
import { isChatTarget } from "../../platforms/ports/chat-target.js";

/**
 * Каталог настроек без релиза (docs/35-stage4-plan.md §3.18, Р53).
 *
 * Значение берётся по порядку: строка в базе (`app_setting`, её пишет панель)
 * → окружение → умолчание здесь. База сильнее окружения: иначе поправить
 * настройку из панели было бы нельзя, пока в `.env` сервера лежит старое.
 * Сброс в панели удаляет строку, и снова работает окружение.
 *
 * Ключ и схема значения живут в коде: неизвестный ключ из базы
 * игнорируется, а значение, не прошедшее схему, — тоже, с предупреждением в
 * логе, и работает окружение. Секреты сюда не попадают никогда: в панели
 * значение видно всем, у кого есть право `settings.edit`.
 */

export type SettingValue = string | boolean | number;

export type SettingKind = "chat" | "boolean" | "url" | "number";

/**
 * Пределы числа и в чём оно — для редактора панели: поле не даст ввести
 * лишнего, а значение читается словами — «3 минуты», «5 забегов». Формы —
 * для одного, двух и пяти.
 */
export interface SettingRange {
  readonly min: number;
  readonly max: number;
  readonly unit: readonly [string, string, string];
}

export interface SettingDefinition<T extends SettingValue = SettingValue> {
  /** `notify.chat.general` — латиница, точки, дефисы */
  readonly key: string;
  /** раздел в панели */
  readonly group: string;
  readonly title: string;
  /** что меняет и что значит пустое значение — для панели */
  readonly hint: string;
  /** какой редактор показать в панели */
  readonly kind: SettingKind;
  readonly schema: z.ZodType<T>;
  /** пределы и единица числа; у остальных видов нет */
  readonly range?: SettingRange;
  /** значение из окружения; `null` — в окружении не задано */
  readonly fromEnv: (config: AppConfig) => T | null;
  readonly fallback: T;
}

export const SETTING_KEY = /^[a-z][a-z0-9.-]{1,63}$/;

const NOTIFY_GROUP = "Уведомления команде";

const chatSchema = z
  .string()
  .trim()
  .max(32)
  .refine(isChatTarget, { message: "id чата или id:тема, например -1001234567890:57" });

function chat(key: string, title: string, hint: string, env: (config: AppConfig) => string): SettingDefinition<string> {
  return {
    key,
    group: NOTIFY_GROUP,
    title,
    hint,
    kind: "chat",
    schema: chatSchema,
    fromEnv: (config) => {
      const value = env(config);
      return value === "" ? null : value;
    },
    fallback: "",
  };
}

const SHOP_GROUP = "Магазин";

/** Ссылка из панели — только https, до 256 знаков; пусто — «не задана». */
const urlSchema = z
  .string()
  .trim()
  .max(256)
  .refine((value) => value === "" || (URL.canParse(value) && new URL(value).protocol === "https:"), { message: "ссылка https://… или пусто" });

const FEATURES_GROUP = "Функции сервера";

const ADS_GROUP = "Реклама";

const HOME_GROUP = "Главная";

/**
 * Целое число в пределах — схема и пределы из одного места: панель
 * проверит то же самое, что сервер. Без окружения: такие числа — продуктовые
 * решения, их правят в панели, а не в `.env` сервера.
 */
function integer(key: string, group: string, title: string, hint: string, range: SettingRange, fallback: number): SettingDefinition<number> {
  const schema = z
    .number()
    .int({ message: "целое число" })
    .min(range.min, { message: `не меньше ${String(range.min)}` })
    .max(range.max, { message: `не больше ${String(range.max)}` });
  return { key, group, title, hint, kind: "number", schema, range, fromEnv: () => null, fallback };
}

/**
 * Выключатель функции без своего ключа (§3.18): у входа ключ есть, и он
 * включается ключом, а приёмникам, курсам и выгрузке ключ не нужен — их
 * включает настройка. Переменная `…_ENABLED` — её запасное значение.
 */
function feature(key: string, title: string, hint: string, env: (config: AppConfig) => boolean | null, fallback: boolean): SettingDefinition<boolean> {
  return { key, group: FEATURES_GROUP, title, hint, kind: "boolean", schema: z.boolean(), fromEnv: env, fallback };
}

/**
 * Места уведомлений команде — первыми в каталоге (§3.18): чат меняется
 * чаще всего остального, а без релиза его раньше было не поменять.
 */
export const SETTINGS = {
  chatGeneral: chat(
    "notify.chat.general",
    "Общий чат администраторов",
    "Меню команд администратора и всё, у чего нет своего потока. Пусто — бот команде не пишет",
    (config) => config.telegram.chatEnv.general,
  ),
  chatStats: chat("notify.chat.stats", "Статистика", "Ежедневная статистика в 00:10 по Москве и ответы на /stats. Пусто — общий чат", (config) => config.telegram.chatEnv.stats),
  chatStress: chat("notify.chat.stress", "Стресс-тесты", "Карточки стресс-тестов. Пусто — общий чат", (config) => config.telegram.chatEnv.stressReports),
  chatRuns: chat("notify.chat.runs", "Проблемные забеги", "Карточки записей забегов с просадками. Пусто — общий чат", (config) => config.telegram.chatEnv.runReports),
  chatFeedback: chat("notify.chat.feedback", "Отзывы игроков", "Отзывы с формы обратной связи. Пусто — общий чат", (config) => config.telegram.chatEnv.feedback),
  chatRunReview: chat(
    "notify.chat.run-review",
    "Разбор забегов",
    "Подозрительные и отклонённые забеги — очередь антифрода. Пусто — общий чат",
    (config) => config.telegram.chatEnv.runReview,
  ),
  notifyReports: {
    key: "notify.reports",
    group: NOTIFY_GROUP,
    title: "Карточки отчётов диагностики",
    hint: "Слать в чат стресс-тесты и проблемные забеги. Разбор забегов от этого не зависит",
    kind: "boolean",
    schema: z.boolean(),
    fromEnv: (config) => config.notifyReports,
    fallback: true,
  } satisfies SettingDefinition<boolean>,
  ingestEvents: feature(
    "ingest.events",
    "Приём событий аналитики",
    "События игры с устройств. Выключенный приёмник отвечает 404, а клиент копит события у себя. Нужна база",
    (config) => config.ingest.eventsEnv,
    false,
  ),
  ingestReports: feature(
    "ingest.reports",
    "Приём отчётов диагностики",
    "Стресс-тесты и записи забегов с устройств. Выключенный приёмник отвечает 404. Нужна база",
    (config) => config.ingest.reportsEnv,
    false,
  ),
  fxPolling: feature(
    "fx.polling",
    "Опрос курсов валют",
    "Раз в минуту решает, кому из источников курсов пора, и ходит к ним в интернет. Выключен — курсы стареют",
    (config) => config.fx.pollingEnv,
    false,
  ),
  exportBot: feature(
    "export.bot",
    "Выгрузка через бота",
    "Кнопка выгрузки данных у администратора в боте. Утёк токен бота — выключить. Нужны EXPORT_PSEUDONYM_KEY и чтение обновлений бота",
    (config) => config.export.botEnv,
    false,
  ),
  stressForAll: feature(
    "diagnostics.stress-for-all",
    "Стресс-тест для всех игроков",
    "Кнопка стресс-теста у каждого игрока, а не только у команды с правом tools.dev: для открытых проверок производительности устройств",
    () => null,
    false,
  ),
  shopTributeUrl: {
    key: "shop.tribute-url",
    group: SHOP_GROUP,
    title: "Ссылка на Tribute",
    hint: "Плашка «Звёзды дешевле через Tribute» во вкладке самоцветов магазина, только в Telegram. Пусто — плашки нет",
    kind: "url",
    schema: urlSchema,
    fromEnv: () => null,
    fallback: "",
  } satisfies SettingDefinition<string>,
  /**
   * Канал проекта (docs/35-stage4-plan.md WP42): слайд «Наш канал» в
   * карусели главной. Не секрет и меняется без релиза — канал можно
   * переименовать или завести новый.
   */
  homeChannelUrl: {
    key: "home.channel-url",
    group: HOME_GROUP,
    title: "Канал проекта",
    hint: "Слайд «Наш канал» в карусели главной ведёт сюда — ссылка https://t.me/… Пусто — слайда нет",
    kind: "url",
    schema: urlSchema,
    fromEnv: () => null,
    fallback: "",
  } satisfies SettingDefinition<string>,
  /**
   * Тестовые показы сетей (docs/35-stage4-plan.md WP12): SDK получает
   * `debug` и крутит пробные ролики. Без окружения: на тестовом сервере её
   * включают из панели, а боевой сервер не может унаследовать её из `.env`.
   */
  adsTestMode: {
    key: "ads.test-mode",
    group: ADS_GROUP,
    title: "Тестовые показы рекламы",
    hint: "Сети крутят пробные ролики вместо настоящих: их не засчитывают и за них не платят. Для проверки блоков на тестовом сервере — в бою держать выключенным",
    kind: "boolean",
    schema: z.boolean(),
    fromEnv: () => null,
    fallback: false,
  } satisfies SettingDefinition<boolean>,
  /**
   * Частота межстраничной (docs/35-stage4-plan.md WP12, часть 10, О18):
   * когда её показывать, решает политика площадки
   * (`ads/interstitial-policy.ts`), а как часто — эти числа. Рабочие числа:
   * их уточнит выкат на долю игроков.
   */
  interstitialEveryRuns: integer(
    "ads.interstitial.every-runs",
    ADS_GROUP,
    "Межстраничная: каждые N забегов",
    "При старте забега, перед каждым N-м. Считаются забеги не короче минуты. Показ — только у доли игроков флага ads.interstitial в разделе «Флаги» и никогда у VIP",
    { min: 1, max: 20, unit: ["забег", "забега", "забегов"] },
    3,
  ),
  interstitialGapMin: integer(
    "ads.interstitial.gap-min",
    ADS_GROUP,
    "Межстраничная: пауза между показами",
    "Не чаще этого, даже если забеги короткие",
    { min: 1, max: 240, unit: ["минута", "минуты", "минут"] },
    3,
  ),
  interstitialNewbieRuns: integer(
    "ads.interstitial.newbie-runs",
    ADS_GROUP,
    "Межстраничная: новичок без неё — забегов",
    "Сколько первых забегов не короче минуты игрок играет без неё. Новичок — пока не прошли и забеги, и дни. 0 — без ограничения по забегам",
    { min: 0, max: 100, unit: ["забег", "забега", "забегов"] },
    5,
  ),
  interstitialNewbieDays: integer(
    "ads.interstitial.newbie-days",
    ADS_GROUP,
    "Межстраничная: новичок без неё — дней",
    "Сколько игровых суток с первого входа игрок её не видит: 1 — не в день первого входа. Сутки — по Москве, как у заданий. 0 — без ограничения по дням",
    { min: 0, max: 30, unit: ["день", "дня", "дней"] },
    1,
  ),
  interstitialAfterPurchaseHours: integer(
    "ads.interstitial.after-purchase-hours",
    ADS_GROUP,
    "Межстраничная: пауза после покупки",
    "Заплативший звёздами столько её не видит. 0 — без паузы",
    { min: 0, max: 720, unit: ["час", "часа", "часов"] },
    24,
  ),
  interstitialAfterRewardMin: integer(
    "ads.interstitial.after-reward-min",
    ADS_GROUP,
    "Межстраничная: пауза после ролика за награду",
    "Игрок только что сам смотрел рекламу — колесо, удвоение, второй шанс. 0 — без паузы",
    { min: 0, max: 240, unit: ["минута", "минуты", "минут"] },
    10,
  ),
  paymentsStars: feature(
    "payments.stars",
    "Оплата звёздами",
    "Новые счета на второй шанс и подтверждение перед оплатой. Уже оплаченное засчитывается всегда. Нужны вход и чтение обновлений бота",
    (config) => config.payments.starsEnv,
    true,
  ),
} as const;

export const SETTING_LIST: readonly SettingDefinition[] = Object.values(SETTINGS);

export function settingByKey(key: string): SettingDefinition | undefined {
  return SETTING_LIST.find((setting) => setting.key === key);
}
