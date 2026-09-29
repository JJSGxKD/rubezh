import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { z } from "zod";
import { isChatTarget } from "../platforms/ports/chat-target.js";

/**
 * Единая Zod-схема конфигурации: невалидное окружение = процесс не
 * поднимается (docs/20-env-and-ports.md §1, правило 3). Ошибка при старте
 * дешевле неверного поведения в рантайме.
 *
 * Это единственное место в бэкенде, где читается process.env
 * (CLAUDE.md, «Порты и переменные окружения»).
 */
/** Облако Telegram — адрес по умолчанию, когда свой сервер Bot API не задан. */
const TELEGRAM_CLOUD_API = "https://api.telegram.org";

/**
 * Выключатель функции без своего ключа (docs/35-stage4-plan.md §3.18, Р53):
 * запасное значение настройки из каталога (`modules/settings`), а панель
 * сильнее. `null` — в окружении не задан, пустая строка — тоже.
 */
function envSwitch() {
  return z
    .enum(["true", "false", ""])
    .optional()
    .transform((value) => (value === undefined || value === "" ? null : value === "true"));
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().default("0.0.0.0"),
  ALLOWED_ORIGINS: z.string().default(""),
  // Сколько прокси перед API добавляют X-Forwarded-For: за Caddy — 1. IP
  // клиента нужен только лимиту частоты, и берётся он из req.ip Fastify, а не
  // из сырого заголовка, который подделывается одной строкой
  // (docs/13-reuse-from-vpnsibcom.md §2). 0 — API смотрит в сеть напрямую.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

  // Redis — кеш, лидерборды, очереди. Адрес не секрет; пароль, если он есть,
  // лежит в самом URL и в прод-окружении задаётся секретом.
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // Postgres — события и отчёты диагностики. Строка подключения содержит
  // пароль и значения по умолчанию не имеет: функции, которым нужна база,
  // без неё не стартуют.
  DATABASE_URL: z.string().default(""),

  // Приёмники событий и отчётов диагностики (docs/28-diagnostics.md §5).
  // Выключенный приёмник отвечает 404 и не подтверждает, что он есть.
  // Запасные значения настроек `ingest.events` и `ingest.reports`.
  EVENTS_INGEST_ENABLED: envSwitch(),
  DIAGNOSTICS_INGEST_ENABLED: envSwitch(),
  // Окно свежести подписи запуска для приёмников — сутки (docs/28-diagnostics.md
  // §5.2): тестер играет часами, а приёмник в ответ ничего не выдаёт.
  INGEST_INIT_DATA_MAX_AGE_SEC: z.coerce.number().int().positive().default(86_400),
  // Сколько дней хранить сырые события и отчёты диагностики (docs/28-diagnostics.md §5.4).
  DIAGNOSTICS_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),

  // Выгрузка данных закрытого теста (docs/28-diagnostics.md §6). Ключ HMAC для
  // псевдонимов Telegram ID — секрет без значения по умолчанию: обычный хэш
  // короткого числового ID обращается перебором за минуты. Смена ключа меняет
  // все псевдонимы — выгрузки до и после перестают сопоставляться.
  EXPORT_PSEUDONYM_KEY: z
    .string()
    .default("")
    .refine((value) => value === "" || /^[0-9a-f]{64,}$/i.test(value), {
      message: "EXPORT_PSEUDONYM_KEY — не короче 64 шестнадцатеричных знаков: openssl rand -hex 32",
    }),
  // Выключатель выгрузки через бота: при утечке токена бота выгрузка
  // отключается без релиза (docs/28-diagnostics.md §6.1.4). Запасное значение
  // настройки `export.bot`: выключают её в панели.
  DATA_EXPORT_BOT_ENABLED: envSwitch(),

  // Плейтест: сводка, отчёты о запуске, стресс-тест для всех
  // (docs/26-stage2-plan.md, WP14). Забеги и рейтинг — модуль runs под
  // авторизацией, поэтому плейтест без неё не включается.
  PLAYTEST_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  // Через сколько дней без записей данные сводки плейтеста исчезают сами.
  PLAYTEST_DATA_TTL_DAYS: z.coerce.number().int().positive().default(45),
  // Переименована в AUTH_DEV_LOGIN: вход разработчика теперь заводит аккаунт,
  // а не подписывает запросы плейтеста.
  PLAYTEST_DEV_AUTH: z.string().default(""),

  // Адрес Bot API. Пусто — облако Telegram; свой адрес нужен тем, кто держит
  // локальный сервер Bot API (docs/20-env-and-ports.md §3.1): у него другой
  // хост, а методы и пути те же.
  TELEGRAM_API_ROOT: z
    .string()
    .default("")
    .refine((value) => value === "" || /^https?:\/\/[^\s]+$/.test(value), {
      message: "TELEGRAM_API_ROOT — адрес с http:// или https://",
    }),
  // Откуда бот берёт обновления (docs/28-diagnostics.md §6.1.3): `webhook` —
  // сервер с публичным адресом, `polling` — машина разработчика без него,
  // `off` — бот не отвечает.
  TELEGRAM_BOT_UPDATES: z.enum(["off", "polling", "webhook"]).default("off"),
  // Секретный токен вебхука: Telegram шлёт его заголовком, без него обновление
  // отклоняется. Секрет, без значения по умолчанию; алфавит — из Bot API.
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .default("")
    .refine((value) => value === "" || /^[A-Za-z0-9_-]{32,256}$/.test(value), {
      message: "TELEGRAM_WEBHOOK_SECRET — от 32 знаков A-Z, a-z, 0-9, _ и -",
    }),
  // Публичный адрес API — куда регистрировать вебхук (`pnpm bot:webhook`).
  PUBLIC_API_URL: z.string().default(""),
  // Адрес Mini App для кнопки «Играть» под приветствием. Telegram принимает
  // только HTTPS: без него карточка уходит без кнопки.
  PUBLIC_WEB_URL: z.string().default(""),
  // Куда пишет бот команде. Значение — id чата или `id:тема` для супергруппы
  // с темами (docs/20-env-and-ports.md §3). ADMIN_CHAT_ID — общий адрес;
  // остальные переопределяют его для своего потока, пустые берут общий.
  // Настройка из панели сильнее окружения (modules/settings/setting-catalog.ts).
  ADMIN_CHAT_ID: chatTarget("ADMIN_CHAT_ID"),
  ADMIN_CHAT_STATS: chatTarget("ADMIN_CHAT_STATS"),
  ADMIN_CHAT_STRESS: chatTarget("ADMIN_CHAT_STRESS"),
  ADMIN_CHAT_RUNS: chatTarget("ADMIN_CHAT_RUNS"),
  ADMIN_CHAT_FEEDBACK: chatTarget("ADMIN_CHAT_FEEDBACK"),
  ADMIN_CHAT_RUN_REVIEW: chatTarget("ADMIN_CHAT_RUN_REVIEW"),
  // Уведомлять чат администраторов о новых отчётах диагностики: стресс-тест —
  // карточкой с графиком. Работает, когда задан ADMIN_CHAT_ID и включён приёмник.
  // Не задана — умолчание из каталога настроек (включено); панель сильнее.
  ADMIN_NOTIFY_REPORTS: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value === undefined ? null : value === "true")),
  // Переименована в ADMIN_CHAT_ID: чат теперь получает не только сводку.
  PLAYTEST_STATS_CHAT_ID: z.string().default(""),

  // Сводка статистики плейтеста в чат администраторов (docs/26-stage2-plan.md, WP14).
  // Включённая сводка без чата, токена или чтения обновлений не стартует.
  PLAYTEST_STATS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // Когда присылать сводку сама, «ЧЧ:ММ» в поясе команды; пусто — только по команде.
  PLAYTEST_STATS_DAILY_AT: z
    .string()
    .default("21:00")
    .refine((value) => value === "" || /^([01]\d|2[0-3]):[0-5]\d$/.test(value), { message: "PLAYTEST_STATS_DAILY_AT — время ЧЧ:ММ" }),
  // Пояс команды для «сегодня» и времени отчёта: сервер живёт в UTC.
  PLAYTEST_STATS_UTC_OFFSET_MIN: z.coerce.number().int().min(-720).max(840).default(180),

  // Авторизация игроков (docs/34-stage3-plan.md, WP1) включается ключом
  // (Р53): задан секрет подписи — вход работает, пуст — эндпоинты отвечают
  // 404. Старый флаг убран; строку можно удалить, а противоречащая ключу
  // роняет старт — иначе «выключено» в окружении молча значило бы «включено».
  AUTH_ENABLED: envSwitch(),
  // Секрет подписи токена доступа. Без значения по умолчанию: подписанный
  // известным секретом токен — это отсутствие авторизации.
  JWT_ACCESS_SECRET: z
    .string()
    .default("")
    .refine((value) => value === "" || /^[0-9a-f]{64,}$/i.test(value), {
      message: "JWT_ACCESS_SECRET — не короче 64 шестнадцатеричных знаков: openssl rand -hex 32",
    }),
  // Токен доступа живёт минутами: украденный не должен работать до вечера, а
  // клиент молча обновляет его по токену продления.
  AUTH_ACCESS_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),
  AUTH_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  // Окно свежести данных запуска для входа — не больше часа: на этой сессии
  // работают деньги (docs/33-telegram-mini-app-pitfalls.md §1.2). Потолок в
  // схеме, а не в договорённости: иначе однажды его поднимут «на время».
  AUTH_INIT_DATA_MAX_AGE_SEC: z.coerce.number().int().min(60).max(3600).default(3600),
  // Сколько устройств помнит аккаунт. Сверх лимита вытесняется самое старое:
  // без потолка список сессий рос бы бесконечно.
  AUTH_MAX_SESSIONS: z.coerce.number().int().min(1).max(50).default(10),
  // Вход без Telegram по имени — только для локальной разработки в браузере:
  // так команда проверяет рейтинг и профиль, не открывая клиент Telegram.
  AUTH_DEV_LOGIN: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  // Пороги антифрода забегов, фаза 1 (docs/34-stage3-plan.md, WP4, Р7).
  //
  // В коде — только структура проверок, а числа — здесь: опубликованный порог
  // говорит читеру, сколько ровно можно. Умолчания нарочно мягкие и ловят
  // лишь невозможное: замер по 108 забегам ботов (три сложности, три
  // стартовых оружия, два уровня игры) дал максимум 8,6 убийства в секунду и
  // 4,6 уровня в минуту, умолчания взяты с пятикратным запасом. Боевые
  // значения задаются окружением прода.
  RUNS_MAX_KILLS_PER_SEC: z.coerce.number().positive().default(40),
  RUNS_MAX_LEVELS_PER_MIN: z.coerce.number().positive().default(12),
  // Сборки, чьи забеги принимаются без вопросов: отпечатки контента через
  // запятую. Пусто — проверка выключена. Незнакомый отпечаток — не отказ, а
  // `suspicious`: новая сборка могла выйти раньше, чем обновили список.
  RUNS_KNOWN_CONTENT_HASHES: z
    .string()
    .default("")
    .transform((value) => value.split(",").map((hash) => hash.trim()).filter((hash) => hash !== "")),
  // Запас на заявленное время выживания сверх прошедшего по часам сервера.
  // Честный забег длиннее прошедшего времени не бывает: пауза в игровое время
  // не идёт. Запас — на округление и на опоздание сообщения о старте.
  RUNS_WALL_CLOCK_TOLERANCE_SEC: z.coerce.number().min(0).max(300).default(10),
  // Насколько поздно может прийти сообщение о старте, чтобы ему ещё верить.
  // Пришло позже — время забега не проверяется: иначе честный игрок, у
  // которого старт пролежал в очереди без сети, получил бы «дольше, чем
  // прошло».
  RUNS_START_MAX_DELAY_SEC: z.coerce.number().min(0).max(600).default(30),

  // Оплата второго шанса за Telegram Stars (docs/34-stage3-plan.md, WP5)
  // возможна при входе — покупка принадлежит аккаунту — и чтении обновлений
  // бота: без ответа на предварительную проверку Telegram срывает каждую
  // оплату через десять секунд, а подтверждение оплаты приходит тоже
  // обновлением. Это деньги, поэтому у оплаты есть стоп-кран — настройка
  // `payments.stars`, а переменная — её запасное значение.
  PAYMENTS_ENABLED: envSwitch(),
  // Тестовая оплата (Р14): игрок видит настоящую цену, списывается одна
  // звезда и тут же возвращается, покупка засчитана. Песочницы у Stars нет,
  // а копить звёзды на тестовом боте незачем. Только в development: в проде
  // с ней продолжение стоило бы звезду.
  PAYMENTS_TEST_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // Курсы валют (docs/35-stage4-plan.md, §3.12, WP9): опрос бесплатных
  // источников. Выключен по умолчанию — включённый ходит в интернет.
  // Запасное значение настройки `fx.polling`.
  FX_ENABLED: envSwitch(),
  // Ключи CoinGecko — необязательные секреты, у них нет значения по умолчанию:
  // пусто и значит «без ключа». С ключом адаптер сам берёт тариф и частоту
  // опроса (packages/fx/src/sources/crypto.ts).
  FX_COINGECKO_DEMO_KEY: z.string().trim().default(""),
  FX_COINGECKO_PRO_KEY: z.string().trim().default(""),
  // Цена второго шанса (Р5.1): звёзд за каждую начатую минуту забега и
  // потолок цены. Считает сервер, клиент цену только показывает. Рабочие
  // значения до решения геймдизайнера (О1). Потолок схемы — с запасом под
  // ограничение Telegram на сумму одного счёта.
  CONTINUE_STARS_PER_MINUTE: z.coerce.number().int().min(1).max(100).default(1),
  CONTINUE_MAX_STARS: z.coerce.number().int().min(1).max(2500).default(30),

  // Администраторы — Telegram ID через запятую (docs/28-diagnostics.md §6.1.1).
  // Список не секрет; мусор в нём — процесс не поднимается, пустой — функции
  // администратора выключены.
  ADMIN_TELEGRAM_IDS: z
    .string()
    .default("")
    .transform((value) => value.split(",").map((id) => id.trim()).filter((id) => id !== ""))
    .refine((ids) => ids.every((id) => /^\d{1,20}$/.test(id)), {
      message: "ADMIN_TELEGRAM_IDS — Telegram ID цифрами через запятую",
    }),

  // Серверная часть панели (docs/35-stage4-plan.md, WP17; docs/29-admin-panel.md
  // §4, §8): своя cookie-сессия под `/api/v1/admin/*`. Работает вместе со
  // входом: панель живёт на аккаунтах и ролях, а без роли в неё не пускают.
  // Своего выключателя у неё нет — выключенную из самой панели включить было
  // бы неоткуда. Старый флаг — как у входа: противоречащий входу роняет старт.
  ADMIN_PANEL_ENABLED: envSwitch(),
  // Срок жизни сессии панели в минутах — без продления по активности: забытый
  // ноутбук не должен держать вход в панель сутками (§8).
  ADMIN_SESSION_TTL_MIN: z.coerce.number().int().min(5).max(1440).default(480),
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  apiPort: number;
  apiHost: string;
  allowedOrigins: string[];
  trustProxyHops: number;
  redisUrl: string;
  /** пусто — база не настроена */
  databaseUrl: string;
  ingest: {
    /** запасное значение настройки `ingest.events`; `null` — не задано */
    eventsEnv: boolean | null;
    /** запасное значение настройки `ingest.reports` */
    reportsEnv: boolean | null;
    initDataMaxAgeSec: number;
    retentionDays: number;
  };
  export: {
    /** пусто — выгрузка невозможна: псевдонимизировать нечем */
    pseudonymKey: string;
    /** запасное значение настройки `export.bot` */
    botEnv: boolean | null;
    /** выгрузка через бота возможна: ключ псевдонимов, база, чтение обновлений */
    botPossible: boolean;
  };
  /** уведомлять чат администраторов о новых отчётах диагностики; `null` — в окружении не задано */
  notifyReports: boolean | null;
  /** Telegram ID администраторов строками — так же, как id игрока из initData */
  adminTelegramIds: ReadonlySet<string>;
  admin: {
    /** серверная часть панели под `/api/v1/admin/*` — вместе со входом */
    enabled: boolean;
    /** сколько живёт cookie-сессия панели, без продления */
    sessionTtlSec: number;
  };
  telegram: {
    /** бот закрытого теста: проверка подписи initData и сам бот */
    botToken: string;
    updates: "off" | "polling" | "webhook";
    /** адрес Bot API без косой в конце: облако Telegram или свой сервер */
    apiRoot: string;
    /** секретный токен вебхука; пусто — вебхук не настроен */
    webhookSecret: string;
    /** публичный адрес API без косой в конце — для регистрации вебхука */
    publicApiUrl: string;
    /** адрес Mini App для кнопки «Играть» */
    webAppUrl: string;
    /**
     * Адреса чатов команды, как они записаны в окружении. Действующий адрес —
     * у `NotifyTargets` (modules/settings): настройка из панели сильнее.
     */
    chatEnv: AdminChatValues;
  };
  auth: {
    /** задан секрет подписи — вход работает (Р53) */
    enabled: boolean;
    /** секрет подписи токена доступа; пусто — авторизация выключена */
    accessSecret: string;
    accessTtlSec: number;
    refreshTtlSec: number;
    /** окно свежести данных запуска при входе — не больше часа */
    initDataMaxAgeSec: number;
    /** сколько устройств помнит аккаунт */
    maxSessions: number;
    /** вход разработчика по имени, без подписи; только в development */
    devLogin: boolean;
  };
  fx: {
    /** запасное значение настройки `fx.polling` */
    pollingEnv: boolean | null;
    /** ключ CoinGecko: платный важнее демо, нет обоих — без ключа */
    coingeckoKey: { plan: "demo" | "pro"; value: string } | null;
  };
  payments: {
    /** оплата возможна: вход и чтение обновлений бота; включена ли — настройка `payments.stars` */
    possible: boolean;
    /** запасное значение настройки `payments.stars` */
    starsEnv: boolean | null;
    /** тестовая оплата: одна звезда с немедленным возвратом; только development */
    testMode: boolean;
    /** звёзд за каждую начатую минуту забега */
    starsPerMinute: number;
    /** потолок цены второго шанса */
    maxStars: number;
  };
  runs: {
    maxKillsPerSec: number;
    maxLevelsPerMin: number;
    /** пусто — проверка отпечатка контента выключена */
    knownContentHashes: ReadonlySet<string>;
    wallClockToleranceSec: number;
    startMaxDelaySec: number;
  };
  playtest: {
    enabled: boolean;
    dataTtlSec: number;
    stats: {
      enabled: boolean;
      /** минута суток в поясе команды; `null` — сводка только по команде */
      dailyAtMin: number | null;
    };
    statsUtcOffsetMin: number;
  };
}

/** Адреса чатов команды строками из окружения; пусто — не задан. */
export interface AdminChatValues {
  general: string;
  stats: string;
  stressReports: string;
  runReports: string;
  feedback: string;
  runReview: string;
}

function chatTarget(name: string) {
  return z
    .string()
    .default("")
    .refine(isChatTarget, { message: `${name} — id чата или id:тема, например -1001234567890:57` });
}

export const APP_CONFIG = Symbol("APP_CONFIG");

/**
 * `.env` один на весь монорепо и лежит в корне (docs/20-env-and-ports.md §1,
 * правило 1). Путь считается от файла, а не от рабочего каталога: бэкенд
 * запускают и из корня, и из backend/api, и из контейнера.
 */
export function loadRootEnv(): void {
  loadDotenv({ path: repoRoot(".env") });
}

/**
 * Корень монорепо считается от файла, а не от `process.cwd()`: бэкенд
 * запускают и из корня (`pnpm dev`), и из `backend/api`, и из контейнера.
 */
function repoRoot(...segments: string[]): string {
  return resolve(import.meta.dirname, "../../../../", ...segments);
}

function minuteOfDay(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

export function loadAppConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = schema.parse(env);
  // Вход включается ключом (Р53); всё, что зависит от входа, смотрит сюда.
  const authEnabled = parsed.JWT_ACCESS_SECRET !== "";
  const botUpdates = parsed.TELEGRAM_BOT_UPDATES !== "off";

  // У секретов не бывает значений по умолчанию: включённая функция без
  // токена не стартует, а не «пока сойдёт» (docs/20-env-and-ports.md §1,
  // правило 4).
  if (parsed.PLAYTEST_ENABLED && !authEnabled) {
    throw new Error("PLAYTEST_ENABLED=true требует входа — JWT_ACCESS_SECRET: забеги и отчёты о запуске приходят под аккаунтом");
  }
  if (parsed.PLAYTEST_STATS_CHAT_ID !== "") {
    throw new Error("PLAYTEST_STATS_CHAT_ID переименована в ADMIN_CHAT_ID: чат администраторов получает не только сводку");
  }
  if (parsed.TELEGRAM_BOT_UPDATES === "webhook" && parsed.TELEGRAM_WEBHOOK_SECRET === "") {
    throw new Error("TELEGRAM_BOT_UPDATES=webhook требует TELEGRAM_WEBHOOK_SECRET: без него вебхук принимал бы обновления от кого угодно");
  }
  if (parsed.TELEGRAM_BOT_UPDATES !== "off" && parsed.TELEGRAM_BOT_TOKEN === "") {
    throw new Error(`TELEGRAM_BOT_UPDATES=${parsed.TELEGRAM_BOT_UPDATES} требует TELEGRAM_BOT_TOKEN`);
  }
  if (parsed.PLAYTEST_STATS_ENABLED && ((parsed.ADMIN_CHAT_STATS === "" && parsed.ADMIN_CHAT_ID === "") || parsed.TELEGRAM_BOT_UPDATES === "off")) {
    throw new Error("PLAYTEST_STATS_ENABLED=true требует ADMIN_CHAT_ID (или ADMIN_CHAT_STATS) и чтения обновлений бота (TELEGRAM_BOT_UPDATES)");
  }
  const exportPossible = parsed.EXPORT_PSEUDONYM_KEY !== "" && parsed.DATABASE_URL !== "" && botUpdates;
  if (parsed.DATA_EXPORT_BOT_ENABLED === true && !exportPossible) {
    throw new Error("DATA_EXPORT_BOT_ENABLED=true требует EXPORT_PSEUDONYM_KEY, DATABASE_URL и чтения обновлений бота (TELEGRAM_BOT_UPDATES)");
  }
  if ((parsed.EVENTS_INGEST_ENABLED === true || parsed.DIAGNOSTICS_INGEST_ENABLED === true) && parsed.DATABASE_URL === "") {
    throw new Error("Приёмники событий и отчётов пишут в Postgres: включённый приёмник требует DATABASE_URL");
  }
  // Молча игнорировать нельзя только включённую: у всей команды в `.env`
  // осталась строка "false" из прошлого `.env.example`.
  if (parsed.PLAYTEST_DEV_AUTH === "true") {
    throw new Error("PLAYTEST_DEV_AUTH переименована в AUTH_DEV_LOGIN: вход разработчика теперь заводит аккаунт");
  }
  // Вход без подписи — дыра, если попадёт куда-то кроме машины разработчика.
  // Процесс не поднимается, а не «предупреждает».
  if (parsed.AUTH_DEV_LOGIN && parsed.NODE_ENV !== "development") {
    throw new Error("AUTH_DEV_LOGIN=true допустим только при NODE_ENV=development");
  }
  if (parsed.AUTH_DEV_LOGIN && !authEnabled) {
    throw new Error("AUTH_DEV_LOGIN=true требует входа — JWT_ACCESS_SECRET: вход разработчика выдаёт ту же сессию, что вход по Telegram");
  }
  // Старые флаги входа и панели: совпадающий с ключом молча принимается,
  // противоречащий — роняет старт. Иначе AUTH_ENABLED=false при заданном
  // секрете тихо значило бы «вход включён».
  if (parsed.AUTH_ENABLED !== null && parsed.AUTH_ENABLED !== authEnabled) {
    throw new Error(
      authEnabled
        ? "AUTH_ENABLED убрана: вход включается ключом JWT_ACCESS_SECRET. Выключить вход — убрать ключ; строку AUTH_ENABLED удалите"
        : "AUTH_ENABLED убрана: вход включается ключом — задайте JWT_ACCESS_SECRET (openssl rand -hex 32), строку AUTH_ENABLED удалите",
    );
  }
  if (parsed.ADMIN_PANEL_ENABLED !== null && parsed.ADMIN_PANEL_ENABLED !== authEnabled) {
    throw new Error("ADMIN_PANEL_ENABLED убрана: панель работает вместе со входом (JWT_ACCESS_SECRET), без роли в неё не пускают; строку удалите");
  }
  if (authEnabled && (parsed.TELEGRAM_BOT_TOKEN === "" || parsed.DATABASE_URL === "")) {
    throw new Error("JWT_ACCESS_SECRET задан — вход включён, и ему нужны TELEGRAM_BOT_TOKEN и DATABASE_URL: без них вход не проверить и аккаунт негде хранить");
  }
  // Тот же приём, что у входа разработчика: процесс не поднимается, а не
  // «предупреждает» — иначе в проде однажды продолжение стоило бы звезду.
  if (parsed.PAYMENTS_TEST_MODE && parsed.NODE_ENV !== "development") {
    throw new Error("PAYMENTS_TEST_MODE=true допустим только при NODE_ENV=development: вне разработки оплата настоящая");
  }
  const paymentsPossible = authEnabled && botUpdates;
  if (parsed.PAYMENTS_ENABLED === true && !paymentsPossible) {
    throw new Error(
      "PAYMENTS_ENABLED=true требует входа (JWT_ACCESS_SECRET) и чтения обновлений бота (TELEGRAM_BOT_UPDATES): покупка принадлежит аккаунту, а оплату подтверждает обновление от Telegram",
    );
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    apiPort: parsed.API_PORT,
    apiHost: parsed.API_HOST,
    allowedOrigins: parsed.ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ""),
    trustProxyHops: parsed.TRUST_PROXY_HOPS,
    redisUrl: parsed.REDIS_URL,
    databaseUrl: parsed.DATABASE_URL,
    ingest: {
      eventsEnv: parsed.EVENTS_INGEST_ENABLED,
      reportsEnv: parsed.DIAGNOSTICS_INGEST_ENABLED,
      initDataMaxAgeSec: parsed.INGEST_INIT_DATA_MAX_AGE_SEC,
      retentionDays: parsed.DIAGNOSTICS_RETENTION_DAYS,
    },
    export: {
      pseudonymKey: parsed.EXPORT_PSEUDONYM_KEY,
      botEnv: parsed.DATA_EXPORT_BOT_ENABLED,
      botPossible: exportPossible,
    },
    notifyReports: parsed.ADMIN_NOTIFY_REPORTS,
    adminTelegramIds: new Set(parsed.ADMIN_TELEGRAM_IDS),
    admin: {
      enabled: authEnabled,
      sessionTtlSec: parsed.ADMIN_SESSION_TTL_MIN * 60,
    },
    telegram: {
      botToken: parsed.TELEGRAM_BOT_TOKEN,
      updates: parsed.TELEGRAM_BOT_UPDATES,
      apiRoot: (parsed.TELEGRAM_API_ROOT === "" ? TELEGRAM_CLOUD_API : parsed.TELEGRAM_API_ROOT).replace(/\/+$/, ""),
      webhookSecret: parsed.TELEGRAM_WEBHOOK_SECRET,
      publicApiUrl: parsed.PUBLIC_API_URL.replace(/\/+$/, ""),
      webAppUrl: parsed.PUBLIC_WEB_URL,
      chatEnv: {
        general: parsed.ADMIN_CHAT_ID.trim(),
        stats: parsed.ADMIN_CHAT_STATS.trim(),
        stressReports: parsed.ADMIN_CHAT_STRESS.trim(),
        runReports: parsed.ADMIN_CHAT_RUNS.trim(),
        feedback: parsed.ADMIN_CHAT_FEEDBACK.trim(),
        runReview: parsed.ADMIN_CHAT_RUN_REVIEW.trim(),
      },
    },
    auth: {
      enabled: authEnabled,
      accessSecret: parsed.JWT_ACCESS_SECRET,
      accessTtlSec: parsed.AUTH_ACCESS_TTL_SEC,
      refreshTtlSec: parsed.AUTH_REFRESH_TTL_DAYS * 24 * 60 * 60,
      initDataMaxAgeSec: parsed.AUTH_INIT_DATA_MAX_AGE_SEC,
      maxSessions: parsed.AUTH_MAX_SESSIONS,
      devLogin: parsed.AUTH_DEV_LOGIN,
    },
    fx: {
      pollingEnv: parsed.FX_ENABLED,
      coingeckoKey:
        parsed.FX_COINGECKO_PRO_KEY !== ""
          ? { plan: "pro", value: parsed.FX_COINGECKO_PRO_KEY }
          : parsed.FX_COINGECKO_DEMO_KEY !== ""
            ? { plan: "demo", value: parsed.FX_COINGECKO_DEMO_KEY }
            : null,
    },
    payments: {
      possible: paymentsPossible,
      starsEnv: parsed.PAYMENTS_ENABLED,
      testMode: parsed.PAYMENTS_TEST_MODE,
      starsPerMinute: parsed.CONTINUE_STARS_PER_MINUTE,
      maxStars: parsed.CONTINUE_MAX_STARS,
    },
    runs: {
      maxKillsPerSec: parsed.RUNS_MAX_KILLS_PER_SEC,
      maxLevelsPerMin: parsed.RUNS_MAX_LEVELS_PER_MIN,
      knownContentHashes: new Set(parsed.RUNS_KNOWN_CONTENT_HASHES),
      wallClockToleranceSec: parsed.RUNS_WALL_CLOCK_TOLERANCE_SEC,
      startMaxDelaySec: parsed.RUNS_START_MAX_DELAY_SEC,
    },
    playtest: {
      enabled: parsed.PLAYTEST_ENABLED,
      dataTtlSec: parsed.PLAYTEST_DATA_TTL_DAYS * 24 * 60 * 60,
      stats: {
        enabled: parsed.PLAYTEST_STATS_ENABLED,
        dailyAtMin: parsed.PLAYTEST_STATS_DAILY_AT === "" ? null : minuteOfDay(parsed.PLAYTEST_STATS_DAILY_AT),
      },
      statsUtcOffsetMin: parsed.PLAYTEST_STATS_UTC_OFFSET_MIN,
    },
  };
}

let environmentConfig: AppConfig | null = null;

/**
 * Конфигурация процесса из окружения — одна на процесс: её читают и модуль
 * конфигурации, и точка входа, которой настройки Fastify нужны до DI.
 */
export function configFromEnvironment(): AppConfig {
  if (environmentConfig === null) {
    loadRootEnv();
    environmentConfig = loadAppConfig(process.env);
  }
  return environmentConfig;
}
