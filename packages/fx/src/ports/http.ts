/**
 * HTTP — порт. Пакет не знает, чем ходят в сеть: в бэкенде это `fetch` Node,
 * в тестах — заготовленные ответы. Каждый запрос — с таймаутом, без
 * исключений (docs/15-engineering-standards.md §5.5).
 */
export interface HttpRequest {
  url: string;
  headers?: Record<string, string>;
  timeoutMs: number;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export interface HttpClient {
  get(request: HttpRequest): Promise<HttpResponse>;
}

export class HttpTimeoutError extends Error {
  constructor(readonly url: string, readonly timeoutMs: number) {
    super(`запрос не уложился в ${timeoutMs} мс: ${url}`);
    this.name = "HttpTimeoutError";
  }
}

/** Ровно то, что нужно от `fetch`: глобальный `fetch` Node подходит без обёрток. */
export type FetchLike = (
  url: string,
  init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

export function fetchHttpClient(fetchImpl: FetchLike = globalThis.fetch): HttpClient {
  return {
    async get(request) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs);
      try {
        const response = await fetchImpl(request.url, { method: "GET", headers: request.headers ?? {}, signal: controller.signal });
        const body = await response.text();
        return { status: response.status, body };
      } catch (error) {
        if (controller.signal.aborted) throw new HttpTimeoutError(request.url, request.timeoutMs);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Клиент теста: ответы по адресу; неизвестный адрес — ошибка, а не пустой ответ, чтобы опечатка в URL адаптера не прошла тихо. */
export class StubHttpClient implements HttpClient {
  readonly requests: HttpRequest[] = [];
  private readonly answers = new Map<string, HttpResponse | Error>();

  answer(urlPrefix: string, response: HttpResponse | Error): this {
    this.answers.set(urlPrefix, response);
    return this;
  }

  async get(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    for (const [prefix, answer] of this.answers) {
      if (request.url.startsWith(prefix)) {
        if (answer instanceof Error) throw answer;
        return answer;
      }
    }
    throw new Error(`тестовый HTTP-клиент не знает адреса ${request.url}`);
  }
}
