import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import { DomainError } from "./domain-error.js";

/**
 * Минимальная форма ответа Fastify вместо его типов: фильтру нужны ровно два
 * метода, и тест подставляет их без поднятия сервера.
 */
interface JsonReply {
  status(code: number): { send(body: unknown): unknown };
}

interface ErrorResponse {
  status: number;
  body: { error: { code: string; message: string } };
}

const logger = new Logger("http");

/**
 * Единая форма ответа: `{ data }` при успехе, `{ error: { code, message } }`
 * при ошибке (docs/15-engineering-standards.md §3). Клиент ветвится по коду,
 * а не по тексту сообщения.
 */
@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const { status, body } = errorBodyFor(exception);
    void host.switchToHttp().getResponse<JsonReply>().status(status).send(body);
  }
}

/** Код ответа и тело по ошибке. */
function errorBodyFor(exception: unknown): ErrorResponse {
  if (exception instanceof DomainError) {
    return { status: exception.status, body: { error: { code: exception.code, message: exception.message } } };
  }

  if (exception instanceof HttpException) {
    // Текст исключения наружу не отдаётся: у ошибок разбора тела он
    // содержит позицию в JSON и внутренние подробности. Клиенту нужен код,
    // подробности — в лог.
    const status = exception.getStatus();
    logger.warn(`HTTP ${status}: ${exception.message}`);
    return { status, body: { error: describeStatus(status) } };
  }

  // Ошибки разбора тела приходят от Fastify и до доменного слоя не доходят.
  // Без этой ветки слишком большой или битый JSON отдавал 500 — то есть «у
  // нас что-то сломалось» вместо «ты прислал не то».
  const clientStatus = clientErrorStatus(exception);
  if (clientStatus !== null) {
    logger.warn(`HTTP ${clientStatus}: ${exception instanceof Error ? exception.message : String(exception)}`);
    return { status: clientStatus, body: { error: describeStatus(clientStatus) } };
  }

  // Неопознанная ошибка наружу не раскрывается: детали уходят в лог, клиент
  // получает код, по которому можно найти запись.
  logger.error("Необработанная ошибка", exception instanceof Error ? exception.stack : String(exception));
  return { status: 500, body: { error: { code: "internal_error", message: "Внутренняя ошибка сервера" } } };
}

/**
 * Ошибки Fastify несут `statusCode`: 413 — тело сверх лимита, 400 — битый
 * JSON, 415 — чужой Content-Type. Пятисотые так не распознаются: это уже
 * наша ошибка, а не клиента.
 */
function clientErrorStatus(exception: unknown): number | null {
  if (typeof exception !== "object" || exception === null) return null;
  const status = "statusCode" in exception ? exception.statusCode : null;
  return typeof status === "number" && status >= 400 && status < 500 ? status : null;
}

/**
 * Стабильный код и русский текст по коду ответа. Коды машиночитаемые и на
 * английском, тексты — для человека (docs/15-engineering-standards.md §3).
 */
function describeStatus(status: number): { code: string; message: string } {
  switch (status) {
    case 400:
      return { code: "bad_request", message: "Некорректный запрос" };
    case 401:
      return { code: "unauthorized", message: "Требуется авторизация" };
    case 403:
      return { code: "forbidden", message: "Доступ запрещён" };
    case 404:
      return { code: "not_found", message: "Не найдено" };
    case 413:
      return { code: "payload_too_large", message: "Тело запроса слишком большое" };
    case 415:
      return { code: "unsupported_media_type", message: "Неподдерживаемый формат тела" };
    case 429:
      return { code: "rate_limited", message: "Слишком много запросов" };
    default:
      return { code: "http_error", message: "Запрос не выполнен" };
  }
}
