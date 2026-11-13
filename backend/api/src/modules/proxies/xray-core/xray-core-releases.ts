import { formatXrayVersion, parseXrayVersion } from "@bh/proxy-kit";
import { z } from "zod";
import { withTimeout } from "../../../common/with-timeout.js";
import { XrayRefreshTooOftenError } from "./xray-core-errors.js";
import { callGitHub, GitHubCallError, parseJson, refusalText } from "./xray-core-github.js";
import { ERROR_TTL_MS, GITHUB_HEADERS, LATEST_TTL_MS, REDIS_KEYS, REDIS_TIMEOUT_MS, REFRESH_MARK_MS, XRAY_RELEASES_HTML_PREFIX, XRAY_RELEASES_URL, type XrayRedis } from "./xray-core-target.js";

/**
 * Свежий выпуск Xray у XTLS (docs/35-stage4-plan.md Р202, tasks/T-0416): запрос
 * без ключа, ответ читается схемой, результат живёт в Redis 6 часов, сбой —
 * 10 минут, чтобы вкладка не стучалась в GitHub при каждом открытии. «Проверить
 * сейчас» идёт мимо кэша и не чаще раза в минуту на всех реплик.
 */

export interface LatestRelease {
  /** нормализованная: три числа без «v» */
  version: string;
  publishedAt: string | null;
  url: string;
  checkedAt: string;
}

export interface ReleaseLookup {
  release: LatestRelease | null;
  error: string | null;
}

export interface ReleasesDeps {
  redis: XrayRedis;
  fetch: typeof fetch;
  now?: () => number;
}

const releaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.string().startsWith(XRAY_RELEASES_HTML_PREFIX),
  published_at: z.string().datetime({ offset: true }).nullable(),
  prerelease: z.boolean(),
  draft: z.boolean(),
});

const cachedReleaseSchema = z.object({ version: z.string(), publishedAt: z.string().nullable(), url: z.string(), checkedAt: z.string() });
const cachedErrorSchema = z.object({ message: z.string(), at: z.string() });

const NOT_PARSED = "Ответ GitHub не разобран";
const NO_RELEASE = "Свежий стабильный выпуск не опубликован";

export class XrayReleases {
  private readonly now: () => number;

  constructor(private readonly deps: ReleasesDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Из кэша, а промах — из сети. Кэш ошибки отвечает вместо сети, пока не истёк. */
  async latest(): Promise<ReleaseLookup> {
    const cached = await this.cachedRelease();
    const cachedError = await this.cachedError();
    if (cached !== null) return { release: cached, error: cachedError };
    if (cachedError !== null) return { release: null, error: cachedError };
    return await this.fetchAndStore();
  }

  /** Мимо кэша, не чаще раза в минуту на всех. Ошибка сети — в ответе и в кэше ошибки, прежний выпуск остаётся. */
  async refresh(): Promise<ReleaseLookup> {
    if (!(await this.takeMark())) throw new XrayRefreshTooOftenError();
    return await this.fetchAndStore();
  }

  private async fetchAndStore(): Promise<ReleaseLookup> {
    const found = await this.fetchLatest();
    if (found.release !== null) {
      await this.remember(REDIS_KEYS.latest, JSON.stringify(found.release), LATEST_TTL_MS);
      await this.forget(REDIS_KEYS.latestError);
    } else if (found.error !== null) {
      await this.remember(REDIS_KEYS.latestError, JSON.stringify({ message: found.error, at: new Date(this.now()).toISOString() }), ERROR_TTL_MS);
    }
    return found;
  }

  private async fetchLatest(): Promise<ReleaseLookup> {
    let reply;
    try {
      reply = await callGitHub(this.deps.fetch, XRAY_RELEASES_URL, { headers: { ...GITHUB_HEADERS } });
    } catch (error: unknown) {
      return { release: null, error: error instanceof GitHubCallError ? error.message : "GitHub недоступен с сервера" };
    }
    if (reply.status < 200 || reply.status >= 300) return { release: null, error: refusalText(reply) };
    const body = releaseSchema.safeParse(parseJson(reply.text));
    if (!body.success) return { release: null, error: NOT_PARSED };
    if (body.data.prerelease || body.data.draft) return { release: null, error: NO_RELEASE };
    const parsed = parseXrayVersion(body.data.tag_name);
    if (parsed === null) return { release: null, error: `Метка выпуска не распознана: ${body.data.tag_name.slice(0, 32)}` };
    return {
      release: {
        version: formatXrayVersion(parsed),
        publishedAt: body.data.published_at === null ? null : new Date(body.data.published_at).toISOString(),
        url: body.data.html_url,
        checkedAt: new Date(this.now()).toISOString(),
      },
      error: null,
    };
  }

  /** Метка «проверяли минуту назад». Без Redis ограничение не поставить — кнопку не закрываем, она за правом `proxies.edit`. */
  private async takeMark(): Promise<boolean> {
    try {
      return (await withTimeout(this.deps.redis.set(REDIS_KEYS.refreshMark, "1", "PX", REFRESH_MARK_MS, "NX"), REDIS_TIMEOUT_MS, "метка проверки выпуска")) !== null;
    } catch {
      return true;
    }
  }

  private async cachedRelease(): Promise<LatestRelease | null> {
    const text = await this.read(REDIS_KEYS.latest);
    if (text === null) return null;
    const parsed = cachedReleaseSchema.safeParse(parseJson(text));
    return parsed.success ? parsed.data : null;
  }

  private async cachedError(): Promise<string | null> {
    const text = await this.read(REDIS_KEYS.latestError);
    if (text === null) return null;
    const parsed = cachedErrorSchema.safeParse(parseJson(text));
    return parsed.success ? parsed.data.message : null;
  }

  /** Redis не ответил — промах: вкладка открывается и без кэша. */
  private async read(key: string): Promise<string | null> {
    try {
      return await withTimeout(this.deps.redis.get(key), REDIS_TIMEOUT_MS, "кэш выпуска Xray");
    } catch {
      return null;
    }
  }

  private async remember(key: string, value: string, ttlMs: number): Promise<void> {
    try {
      await withTimeout(this.deps.redis.set(key, value, "PX", ttlMs), REDIS_TIMEOUT_MS, "запись кэша выпуска Xray");
    } catch {
      // Без Redis кэша нет: следующий вызов спросит GitHub сам.
    }
  }

  private async forget(key: string): Promise<void> {
    try {
      await withTimeout(this.deps.redis.del(key), REDIS_TIMEOUT_MS, "сброс кэша ошибки выпуска Xray");
    } catch {
      // Ошибка доживёт до своего срока.
    }
  }
}
