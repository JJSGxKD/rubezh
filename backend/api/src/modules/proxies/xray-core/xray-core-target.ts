/**
 * Куда и как «Ядро Xray» ходит в GitHub и как долго помнит ответы
 * (docs/35-stage4-plan.md Р202, tasks/T-0416). Всё, что меняют без правки
 * логики, — здесь.
 */

/** Последний стабильный выпуск XTLS: этот адрес черновики и предрелизы не отдаёт. */
export const XRAY_RELEASES_URL = "https://api.github.com/repos/XTLS/Xray-core/releases/latest";
/** Ссылка на выпуск обязана вести в репозиторий XTLS: чужую панель не покажет. */
export const XRAY_RELEASES_HTML_PREFIX = "https://github.com/XTLS/Xray-core/";

/**
 * Что запускаем. Имя файла сверяет тест T-0417: workflow переименуют — тест
 * упадёт, а не кнопка в проде.
 */
export const XRAY_UPDATE_TARGET = {
  repository: "JJSGxKD/rubezh",
  workflow: "xray-bump.yml",
  ref: "dev",
} as const;

export const WORKFLOW_URL = `https://api.github.com/repos/${XRAY_UPDATE_TARGET.repository}/actions/workflows/${XRAY_UPDATE_TARGET.workflow}`;

/** Заголовки каждого запроса к GitHub; `authorization` добавляют только запуск и чтение запусков. */
export const GITHUB_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "rubezh-api",
} as const;

/** Свежий выпуск: пределов анонимного доступа с таким кэшем хватает с запасом. */
export const LATEST_TTL_MS = 6 * 3_600_000;
/** Сбой GitHub не повторяется на каждом открытии вкладки. */
export const ERROR_TTL_MS = 600_000;
/** «Проверить сейчас» — не чаще раза в минуту на всех. */
export const REFRESH_MARK_MS = 60_000;
export const LAST_RUN_TTL_MS = 30_000;
/** Окно, за которое запущенный workflow точно виден в списке запусков. */
export const UPDATE_LOCK_MS = 600_000;
export const GITHUB_TIMEOUT_MS = 5_000;
/** Redis не ответил за это время — кэш считается промахом. */
export const REDIS_TIMEOUT_MS = 2_000;
/** Файл статуса — две короткие строки; длиннее — не наш файл. */
export const STATUS_MAX_BYTES = 1_024;

export const REDIS_KEYS = {
  latest: "xray-core:latest",
  latestError: "xray-core:latest:error",
  refreshMark: "xray-core:refresh:mark",
  lastRun: "xray-core:last-run",
  updateLock: "xray-core:update:lock",
} as const;

/** Что нужно от Redis: настоящий клиент и подмена теста подходят под эти команды. */
export interface XrayRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<"OK" | null>;
  set(key: string, value: string, mode: "PX", ttlMs: number, nx: "NX"): Promise<"OK" | null>;
  pttl(key: string): Promise<number>;
  del(key: string): Promise<number>;
}
