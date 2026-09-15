import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * Единая Zod-схема конфигурации: невалидное окружение = процесс не
 * поднимается (docs/20-env-and-ports.md §1, правило 3). Ошибка при старте
 * дешевле неверного поведения в рантайме.
 *
 * Это единственное место в бэкенде, где читается process.env
 * (CLAUDE.md, «Порты и переменные окружения»).
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().default("0.0.0.0"),
  ALLOWED_ORIGINS: z.string().default(""),

  // Redis — кеш, лидерборды, очереди. Адрес не секрет; пароль, если он есть,
  // лежит в самом URL и в прод-окружении задаётся секретом.
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // Сохранения и лидерборд плейтеста (docs/26-stage2-plan.md, WP13).
  // Выключены по умолчанию: без токена бота игрока не проверить.
  PLAYTEST_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  // Сколько живут данные запуска Telegram. Для плейтеста — сутки: итог забега
  // уходит через десять минут после открытия приложения, а короткое окно из
  // INIT_DATA_EXPIRES_IN рассчитано на обмен на токен сразу при входе.
  PLAYTEST_INIT_DATA_MAX_AGE_SEC: z.coerce.number().int().positive().default(86_400),
  // Через сколько дней без записей данные плейтеста исчезают сами.
  PLAYTEST_DATA_TTL_DAYS: z.coerce.number().int().positive().default(45),
  // Вход без Telegram по заголовку — только для локальной разработки в браузере.
  PLAYTEST_DEV_AUTH: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  // Сводка статистики плейтеста в чат администраторов (docs/26-stage2-plan.md, WP14).
  // Бот читает команды сам (long polling): у машины разработчика нет публичного
  // адреса для вебхука. Включённая сводка без чата не стартует.
  PLAYTEST_STATS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  PLAYTEST_STATS_CHAT_ID: z
    .string()
    .default("")
    .refine((value) => value === "" || /^-?\d{1,20}$/.test(value), { message: "PLAYTEST_STATS_CHAT_ID — числовой id чата" }),
  // Когда присылать сводку сама, «ЧЧ:ММ» в поясе команды; пусто — только по команде.
  PLAYTEST_STATS_DAILY_AT: z
    .string()
    .default("21:00")
    .refine((value) => value === "" || /^([01]\d|2[0-3]):[0-5]\d$/.test(value), { message: "PLAYTEST_STATS_DAILY_AT — время ЧЧ:ММ" }),
  // Пояс команды для «сегодня» и времени отчёта: сервер живёт в UTC.
  PLAYTEST_STATS_UTC_OFFSET_MIN: z.coerce.number().int().min(-720).max(840).default(180),

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
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  apiPort: number;
  apiHost: string;
  allowedOrigins: string[];
  redisUrl: string;
  /** Telegram ID администраторов строками — так же, как id игрока из initData */
  adminTelegramIds: ReadonlySet<string>;
  playtest: {
    enabled: boolean;
    botToken: string;
    initDataMaxAgeSec: number;
    dataTtlSec: number;
    devAuth: boolean;
    stats: {
      enabled: boolean;
      chatId: string;
      /** минута суток в поясе команды; `null` — сводка только по команде */
      dailyAtMin: number | null;
    };
    statsUtcOffsetMin: number;
  };
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
  return resolve(__dirname, "../../../../", ...segments);
}

function minuteOfDay(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

export function loadAppConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = schema.parse(env);

  // У секретов не бывает значений по умолчанию: включённая функция без
  // токена не стартует, а не «пока сойдёт» (docs/20-env-and-ports.md §1,
  // правило 4).
  if (parsed.PLAYTEST_ENABLED && parsed.TELEGRAM_BOT_TOKEN === "") {
    throw new Error("PLAYTEST_ENABLED=true требует непустого TELEGRAM_BOT_TOKEN: без него игрока не проверить");
  }
  if (parsed.PLAYTEST_STATS_ENABLED && (parsed.PLAYTEST_STATS_CHAT_ID === "" || parsed.TELEGRAM_BOT_TOKEN === "")) {
    throw new Error("PLAYTEST_STATS_ENABLED=true требует PLAYTEST_STATS_CHAT_ID и TELEGRAM_BOT_TOKEN");
  }
  // Вход по заголовку без подписи — дыра, если попадёт куда-то кроме машины
  // разработчика. Процесс не поднимается, а не «предупреждает».
  if (parsed.PLAYTEST_DEV_AUTH && parsed.NODE_ENV !== "development") {
    throw new Error("PLAYTEST_DEV_AUTH=true допустим только при NODE_ENV=development");
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    apiPort: parsed.API_PORT,
    apiHost: parsed.API_HOST,
    allowedOrigins: parsed.ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ""),
    redisUrl: parsed.REDIS_URL,
    adminTelegramIds: new Set(parsed.ADMIN_TELEGRAM_IDS),
    playtest: {
      enabled: parsed.PLAYTEST_ENABLED,
      botToken: parsed.TELEGRAM_BOT_TOKEN,
      initDataMaxAgeSec: parsed.PLAYTEST_INIT_DATA_MAX_AGE_SEC,
      dataTtlSec: parsed.PLAYTEST_DATA_TTL_DAYS * 24 * 60 * 60,
      devAuth: parsed.PLAYTEST_DEV_AUTH,
      stats: {
        enabled: parsed.PLAYTEST_STATS_ENABLED,
        chatId: parsed.PLAYTEST_STATS_CHAT_ID,
        dailyAtMin: parsed.PLAYTEST_STATS_DAILY_AT === "" ? null : minuteOfDay(parsed.PLAYTEST_STATS_DAILY_AT),
      },
      statsUtcOffsetMin: parsed.PLAYTEST_STATS_UTC_OFFSET_MIN,
    },
  };
}
