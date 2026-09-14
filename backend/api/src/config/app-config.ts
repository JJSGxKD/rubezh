import { config as loadDotenv } from "dotenv";
import { isAbsolute, resolve } from "node:path";
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

  // Приёмник отчётов FPS-испытаний (docs/25-week1-fps-trials.md).
  // Выключен по умолчанию: эндпоинт нужен только на время испытаний, и
  // включать его в проде незачем.
  BENCH_INGEST_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  BENCH_INGEST_TOKEN: z.string().default(""),
  // Путь относительный — он разворачивается от корня монорепо, не от
  // рабочего каталога процесса (см. resolveFromRepoRoot).
  BENCH_REPORTS_DIR: z.string().default("var/bench-reports"),

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
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  apiPort: number;
  apiHost: string;
  allowedOrigins: string[];
  bench: {
    enabled: boolean;
    token: string;
    reportsDir: string;
  };
  redisUrl: string;
  playtest: {
    enabled: boolean;
    botToken: string;
    initDataMaxAgeSec: number;
    dataTtlSec: number;
    devAuth: boolean;
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
 * Каталог с отчётами испытаний не должен переезжать в зависимости от того,
 * откуда его запустили, — иначе результаты прогона потом ищут по диску.
 */
function repoRoot(...segments: string[]): string {
  return resolve(__dirname, "../../../../", ...segments);
}

function resolveFromRepoRoot(path: string): string {
  return isAbsolute(path) ? path : repoRoot(path);
}

export function loadAppConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = schema.parse(env);

  // У секретов не бывает значений по умолчанию: включённый приёмник без
  // токена — это открытый эндпоинт, а не «пока сойдёт»
  // (docs/20-env-and-ports.md §1, правило 4).
  if (parsed.BENCH_INGEST_ENABLED && parsed.BENCH_INGEST_TOKEN === "") {
    throw new Error("BENCH_INGEST_ENABLED=true требует непустого BENCH_INGEST_TOKEN");
  }
  if (parsed.PLAYTEST_ENABLED && parsed.TELEGRAM_BOT_TOKEN === "") {
    throw new Error("PLAYTEST_ENABLED=true требует непустого TELEGRAM_BOT_TOKEN: без него игрока не проверить");
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
    bench: {
      enabled: parsed.BENCH_INGEST_ENABLED,
      token: parsed.BENCH_INGEST_TOKEN,
      reportsDir: resolveFromRepoRoot(parsed.BENCH_REPORTS_DIR),
    },
    redisUrl: parsed.REDIS_URL,
    playtest: {
      enabled: parsed.PLAYTEST_ENABLED,
      botToken: parsed.TELEGRAM_BOT_TOKEN,
      initDataMaxAgeSec: parsed.PLAYTEST_INIT_DATA_MAX_AGE_SEC,
      dataTtlSec: parsed.PLAYTEST_DATA_TTL_DAYS * 24 * 60 * 60,
      devAuth: parsed.PLAYTEST_DEV_AUTH,
    },
  };
}
