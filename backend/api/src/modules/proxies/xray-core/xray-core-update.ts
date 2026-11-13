import { z } from "zod";
import { withTimeout } from "../../../common/with-timeout.js";
import { XrayUpdateLockedError, XrayUpdateRefusedError, XrayUpdateUnavailableError, XrayUpdateUnknownError } from "./xray-core-errors.js";
import { callGitHub, GitHubCallError, parseJson, refusalText } from "./xray-core-github.js";
import { GITHUB_HEADERS, LAST_RUN_TTL_MS, REDIS_KEYS, REDIS_TIMEOUT_MS, UPDATE_LOCK_MS, WORKFLOW_URL, XRAY_UPDATE_TARGET, type XrayRedis } from "./xray-core-target.js";

/**
 * Запуск workflow обновления ядра и состояние его последнего запуска
 * (docs/35-stage4-plan.md Р202, tasks/T-0416). Ключ интеграций приходит
 * аргументом и дальше заголовка запроса не уходит: ни в лог, ни в аудит, ни в
 * кэш.
 */

export interface LastRun {
  status: string;
  /** идёт любой запуск, кроме завершённого */
  active: boolean;
  conclusion: string | null;
  url: string;
  createdAt: string;
  title: string;
}

export interface LastRunLookup {
  run: LastRun | null;
  error: string | null;
}

export interface UpdaterDeps {
  redis: XrayRedis;
  fetch: typeof fetch;
  now?: () => number;
}

const runsSchema = z.object({
  workflow_runs: z.array(
    z.object({
      status: z.string(),
      conclusion: z.string().nullable(),
      html_url: z.string().startsWith("https://github.com/"),
      created_at: z.string().datetime({ offset: true }),
      display_title: z.string(),
    }),
  ),
});

const cachedSchema = z.object({
  run: z
    .object({ status: z.string(), active: z.boolean(), conclusion: z.string().nullable(), url: z.string(), createdAt: z.string(), title: z.string() })
    .nullable(),
  error: z.string().nullable(),
});

const lockSchema = z.object({ at: z.string() });

const MESSAGE_MAX = 200;

/** Ответ GitHub об отказе: поле `message`, обрезанное до предела; нет — пустая строка. */
function messageOf(text: string): string {
  const body = parseJson(text);
  if (typeof body !== "object" || body === null || !("message" in body)) return "";
  const message = (body as { message: unknown }).message;
  return typeof message === "string" ? message.slice(0, MESSAGE_MAX) : "";
}

export class XrayCoreUpdater {
  private readonly now: () => number;

  constructor(private readonly deps: UpdaterDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Последний запуск workflow: кэш на 30 секунд, ошибка запроса кэшируется так же. */
  async lastRun(token: string): Promise<LastRunLookup> {
    const cached = await this.cachedRun();
    if (cached !== null) return cached;
    const found = await this.fetchLastRun(token);
    try {
      await withTimeout(this.deps.redis.set(REDIS_KEYS.lastRun, JSON.stringify(found), "PX", LAST_RUN_TTL_MS), REDIS_TIMEOUT_MS, "кэш запуска обновления Xray");
    } catch {
      // Без Redis кэша нет: следующий вызов спросит GitHub сам.
    }
    return found;
  }

  /** Когда замок запуска отпустит; `null` — не держится или Redis не ответил. */
  async lockedUntil(): Promise<Date | null> {
    try {
      const left = await withTimeout(this.deps.redis.pttl(REDIS_KEYS.updateLock), REDIS_TIMEOUT_MS, "замок запуска обновления Xray");
      return left > 0 ? new Date(this.now() + left) : null;
    } catch {
      return null;
    }
  }

  /**
   * Взять замок и запустить workflow. Замок после успеха не снимается: десяти
   * минут хватает, чтобы запуск точно появился в списке. Снимается только при
   * отказе GitHub с ответом, чтобы владелец поправил ключ и нажал снова;
   * таймаут и сбой сети оставляют замок — неизвестно, ушёл ли запуск.
   */
  async dispatch(token: string, version: string, accountId: string): Promise<void> {
    await this.takeLock(version, accountId);
    let reply;
    try {
      reply = await callGitHub(this.deps.fetch, `${WORKFLOW_URL}/dispatches`, {
        method: "POST",
        headers: { ...GITHUB_HEADERS, authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ref: XRAY_UPDATE_TARGET.ref, inputs: { version } }),
      });
    } catch (error: unknown) {
      if (error instanceof GitHubCallError && error.kind === "timeout") throw new XrayUpdateUnknownError("GitHub не ответил за 5 секунд — проверьте запуски через минуту", 504);
      throw new XrayUpdateUnknownError("GitHub недоступен с сервера — проверьте запуски через минуту", 502);
    }
    if (reply.status === 204) {
      await this.drop(REDIS_KEYS.lastRun);
      return;
    }
    if (reply.status === 401 || reply.status === 403) {
      await this.drop(REDIS_KEYS.updateLock);
      throw new XrayUpdateRefusedError("GitHub не принял ключ github.xray-update — проверьте право Actions: Read and write");
    }
    if (reply.status === 404) {
      await this.drop(REDIS_KEYS.updateLock);
      throw new XrayUpdateRefusedError(`Workflow ${XRAY_UPDATE_TARGET.workflow} не найден: GitHub запускает его, только когда файл есть в main`);
    }
    if (reply.status === 422) {
      await this.drop(REDIS_KEYS.updateLock);
      throw new XrayUpdateRefusedError(`GitHub отклонил запуск: ${messageOf(reply.text)}`);
    }
    throw new XrayUpdateUnknownError(`${refusalText(reply)} — проверьте запуски через минуту`, 502);
  }

  private async takeLock(version: string, accountId: string): Promise<void> {
    const value = JSON.stringify({ accountId, version, at: new Date(this.now()).toISOString() });
    let taken: "OK" | null;
    try {
      taken = await withTimeout(this.deps.redis.set(REDIS_KEYS.updateLock, value, "PX", UPDATE_LOCK_MS, "NX"), REDIS_TIMEOUT_MS, "замок запуска обновления Xray");
    } catch {
      throw new XrayUpdateUnavailableError();
    }
    if (taken === null) throw new XrayUpdateLockedError(await this.lockTime());
  }

  /** Когда взят замок, который сейчас держится; не прочиталось — `null`. */
  private async lockTime(): Promise<Date | null> {
    try {
      const text = await withTimeout(this.deps.redis.get(REDIS_KEYS.updateLock), REDIS_TIMEOUT_MS, "замок запуска обновления Xray");
      if (text === null) return null;
      const parsed = lockSchema.safeParse(parseJson(text));
      const at = parsed.success ? new Date(parsed.data.at) : null;
      return at === null || Number.isNaN(at.getTime()) ? null : at;
    } catch {
      return null;
    }
  }

  private async fetchLastRun(token: string): Promise<LastRunLookup> {
    let reply;
    try {
      reply = await callGitHub(this.deps.fetch, `${WORKFLOW_URL}/runs?per_page=1&event=workflow_dispatch`, { headers: { ...GITHUB_HEADERS, authorization: `Bearer ${token}` } });
    } catch (error: unknown) {
      return { run: null, error: error instanceof GitHubCallError ? error.message : "GitHub недоступен с сервера" };
    }
    if (reply.status < 200 || reply.status >= 300) return { run: null, error: refusalText(reply) };
    const body = runsSchema.safeParse(parseJson(reply.text));
    if (!body.success) return { run: null, error: "Ответ GitHub не разобран" };
    const first = body.data.workflow_runs[0];
    if (first === undefined) return { run: null, error: null };
    return {
      run: { status: first.status, active: first.status !== "completed", conclusion: first.conclusion, url: first.html_url, createdAt: new Date(first.created_at).toISOString(), title: first.display_title },
      error: null,
    };
  }

  private async cachedRun(): Promise<LastRunLookup | null> {
    try {
      const text = await withTimeout(this.deps.redis.get(REDIS_KEYS.lastRun), REDIS_TIMEOUT_MS, "кэш запуска обновления Xray");
      if (text === null) return null;
      const parsed = cachedSchema.safeParse(parseJson(text));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async drop(key: string): Promise<void> {
    try {
      await withTimeout(this.deps.redis.del(key), REDIS_TIMEOUT_MS, "сброс ключа Redis");
    } catch {
      // Замок отпустит срок, кэш — его срок.
    }
  }
}
