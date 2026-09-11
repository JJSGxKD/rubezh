import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import { DomainError } from "./domain-error";

/**
 * Минимальная форма ответа вместо типов express.
 *
 * Прямая зависимость от express тянула вторую копию пакета рядом с той, что
 * уже приходит с @nestjs/platform-express, и вместе с ней три уязвимости из
 * аудита. Фильтру нужны ровно два метода — их и описываем.
 */
interface JsonResponse {
  status(code: number): { json(body: unknown): void };
}

/**
 * Единая форма ответа: `{ data }` при успехе, `{ error: { code, message } }`
 * при ошибке (docs/15-engineering-standards.md §3). Клиент ветвится по коду,
 * а не по тексту сообщения.
 */
@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger("http");

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<JsonResponse>();

    if (exception instanceof DomainError) {
      response.status(exception.status).json({
        error: { code: exception.code, message: exception.message },
      });
      return;
    }

    if (exception instanceof HttpException) {
      // Текст исключения наружу не отдаётся: у ошибок разбора тела он
      // содержит позицию в JSON и внутренние подробности. Клиенту нужен код,
      // подробности — в лог.
      const status = exception.getStatus();
      this.logger.warn(`HTTP ${status}: ${exception.message}`);
      response.status(status).json({ error: describeStatus(status) });
      return;
    }

    // Ошибки разбора тела приходят из middleware и до доменного слоя не
    // доходят. Без этой ветки слишком большой или битый JSON отдавал 500 —
    // то есть «у нас что-то сломалось» вместо «ты прислал не то».
    const bodyErrorStatus = describeBodyError(exception);
    if (bodyErrorStatus !== null) {
      response.status(bodyErrorStatus).json({ error: describeStatus(bodyErrorStatus) });
      return;
    }

    // Неопознанная ошибка наружу не раскрывается: детали уходят в лог, клиент
    // получает код, по которому можно найти запись.
    this.logger.error("Необработанная ошибка", exception instanceof Error ? exception.stack : String(exception));
    response.status(500).json({
      error: { code: "internal_error", message: "Внутренняя ошибка сервера" },
    });
  }
}

/**
 * Разбор ошибок body-parser: они приходят из middleware и до доменного слоя
 * не доходят. Без этого слишком большой или битый JSON отдавал 500 — то есть
 * «у нас что-то сломалось» вместо «ты прислал не то».
 */
function describeBodyError(exception: unknown): number | null {
  if (typeof exception !== "object" || exception === null) return null;

  const type = "type" in exception ? exception.type : null;
  if (type === "entity.too.large") return 413;
  if (type === "entity.parse.failed") return 400;

  const status = "status" in exception ? exception.status : null;
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
    case 429:
      return { code: "rate_limited", message: "Слишком много запросов" };
    default:
      return { code: "http_error", message: "Запрос не выполнен" };
  }
}
