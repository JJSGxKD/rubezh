/**
 * Пределы воркера симуляции (docs/35-stage4-plan.md Р15, tasks/T-0302).
 * Числа не из окружения: от них зависят и воркер, и тот, кто ставит задания
 * в очередь, и расходиться им нельзя.
 */

/** Очередь проверок черновика контента в том же Redis, что и очереди сервера. */
export const CONTENT_CHECK_QUEUE = "content-check";

/** Снимок больше этого в очередь не ставится и воркером не разбирается: Redis не склад для JSON. */
export const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
export const SNAPSHOT_TOO_LARGE = "Снимок больше 2 МБ";

/** Прогон дольше предела прерывается: `timeout` в отчёте, посчитанное остаётся. */
export const RUN_LIMIT_MS = 120_000;

/** Ждущих заданий не больше; шестое отклоняется. Выполняемое сюда не входит. */
export const QUEUE_MAX_WAITING = 5;
export const QUEUE_BUSY_MESSAGE = "Проверка уже идёт, дождитесь";

/** Зёрен на сценарий, как в `pnpm balance:sim`: отчёт по умолчанию обязан с ним совпадать. */
export const DEFAULT_SEEDS = 20;
export const MAX_SEEDS = 50;
export const MAX_SCENARIOS = 30;

/** Сколько проблем отчёт перечисляет: всё остальное — «исправьте эти и повторите». */
export const MAX_PROBLEMS = 100;

/** Сколько результатов проверок базы хранится в памяти воркера: у них одна база на многих черновиков. */
export const BASE_CACHE_MAX = 64;
