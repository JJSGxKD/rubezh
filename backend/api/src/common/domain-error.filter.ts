import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { Response } from "express";
import { DomainError } from "./domain-error";

/**
 * Единая форма ответа: `{ data }` при успехе, `{ error: { code, message } }`
 * при ошибке (docs/15-engineering-standards.md §3). Клиент ветвится по коду,
 * а не по тексту сообщения.
 */
@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger("http");

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof DomainError) {
      response.status(exception.status).json({
        error: { code: exception.code, message: exception.message },
      });
      return;
    }

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json({
        error: { code: "http_error", message: exception.message },
      });
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
