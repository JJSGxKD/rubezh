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

export type SettingValue = string | boolean;

export type SettingKind = "chat" | "boolean";

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

const FEATURES_GROUP = "Функции сервера";

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
  chatStats: chat("notify.chat.stats", "Статистика", "Сводка и ответы на /stats. Пусто — общий чат", (config) => config.telegram.chatEnv.stats),
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
