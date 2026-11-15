import { GITHUB_TIMEOUT_MS } from "./xray-core-target.js";

/**
 * Один запрос к GitHub с потолком ожидания и разбором того, что пошло не так
 * (CLAUDE.md: каждый `await` внешнего вызова — с таймаутом). Клиент приходит
 * снаружи — `outbound.forService("github.api")`, — поэтому журнал исходящих и
 * прокси видят все обращения.
 */
export interface GitHubReply {
  status: number;
  headers: Headers;
  text: string;
}

/** Ответа нет: не дождались или не достучались. */
export class GitHubCallError extends Error {
  constructor(
    readonly kind: "timeout" | "network",
    message: string,
  ) {
    super(message);
    this.name = "GitHubCallError";
  }
}

const isTimeout = (error: unknown): boolean => error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

export async function callGitHub(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<GitHubReply> {
  try {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) });
    return { status: response.status, headers: response.headers, text: await response.text() };
  } catch (error: unknown) {
    if (isTimeout(error)) throw new GitHubCallError("timeout", "GitHub не ответил за 5 секунд");
    throw new GitHubCallError("network", "GitHub недоступен с сервера");
  }
}

/** Лимит запросов: 429 или 403 с исчерпанным остатком (так GitHub отвечает анонимам). */
export function isRateLimited(reply: GitHubReply): boolean {
  return reply.status === 429 || (reply.status === 403 && reply.headers.get("x-ratelimit-remaining") === "0");
}

/** Текст ответа, что не 2xx, словами для панели. */
export function refusalText(reply: GitHubReply): string {
  return isRateLimited(reply) ? "GitHub: слишком много запросов — проверим позже" : `GitHub ответил ${String(reply.status)}`;
}

/** JSON из текста ответа; не разобралось — `undefined`, схема отвергнет. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
