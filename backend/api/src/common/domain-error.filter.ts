import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import { DomainError } from "./domain-error.js";

/**
 * Минимальная форма ответа Fastify вместо его типов: фильтру нужны ровно два
 * метода, и тест подставляет их без поднятия сервера.
 */
interface JsonReply {
  status(code: number): { send(body: unknown): unknown };
}

/** То же для запроса: номер, адрес и права, которые положил охранник маршрута. */
interface ErrorRequest {
  id?: unknown;
  url?: unknown;
  adminPermissions?: ReadonlySet<string>;
}

/**
 * Что фильтр знает о запросе, на котором упала ошибка. Отдельный тип, чтобы
 * `errorBodyFor` оставалась чистой функцией, которую проверяют тесты.
 */
export interface ErrorContext {
  /** номер запроса, выданный сервером; `null` — неизвестен */
  requestId: string | null;
  /** адрес запроса; строка запроса после «?» при проверке отбрасывается */
  path: string;
  /** права аккаунта, положенные охранником; `null` — охранник не отработал */
  permissions: ReadonlySet<string> | null;
}

export interface ErrorBody {
  code: string;
  message: string;
  requestId?: string;
  reason?: string;
}

interface ErrorResponse {
  status: number;
  body: { error: ErrorBody };
}

const logger = new Logger("http");

/** Причина — только на маршрутах панели (docs/35-stage4-plan.md, Р193). */
const ADMIN_PATH_PREFIX = "/api/v1/admin/";
const REASON_PERMISSION = "diagnostics.view";
const REASON_MAX_LENGTH = 300;

/**
 * Единая форма ответа: `{ data }` при успехе, `{ error: { code, message } }`
 * при ошибке (docs/15-engineering-standards.md §3). Клиент ветвится по коду,
 * а не по тексту сообщения. К ошибке добавляется номер запроса, а на маршруте
 * панели у аккаунта с правом диагностики — ещё и причина.
 */
@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const { status, body } = errorBodyFor(exception, contextOf(http.getRequest<ErrorRequest | undefined>()));
    void http.getResponse<JsonReply>().status(status).send(body);
  }
}

function contextOf(request: ErrorRequest | undefined): ErrorContext {
  return {
    requestId: typeof request?.id === "string" && request.id !== "" ? request.id : null,
    path: typeof request?.url === "string" ? request.url : "",
    permissions: request?.adminPermissions ?? null,
  };
}

/** Код ответа и тело по ошибке. */
export function errorBodyFor(exception: unknown, context: ErrorContext): ErrorResponse {
  const tag = context.requestId === null ? "" : ` requestId=${context.requestId}`;

  if (exception instanceof DomainError) {
    // Текст доменной ошибки уже человеческий, причины у неё нет.
    return { status: exception.status, body: { error: withRequestId({ code: exception.code, message: exception.message }, context) } };
  }

  if (exception instanceof HttpException) {
    // Текст исключения в `message` не отдаётся: у ошибок разбора тела он
    // содержит позицию в JSON и внутренние подробности. Клиенту нужен код,
    // подробности — в лог, а в `reason` — только тому, кому положено.
    const status = exception.getStatus();
    logger.warn(`HTTP ${status}: ${exception.message}${tag}`);
    return { status, body: { error: withReason(withRequestId(describeStatus(status), context), exception, context) } };
  }

  // Ошибки разбора тела приходят от Fastify и до доменного слоя не доходят.
  // Без этой ветки слишком большой или битый JSON отдавал 500 — то есть «у
  // нас что-то сломалось» вместо «ты прислал не то».
  const clientStatus = clientErrorStatus(exception);
  if (clientStatus !== null) {
    logger.warn(`HTTP ${clientStatus}: ${exception instanceof Error ? exception.message : String(exception)}${tag}`);
    return { status: clientStatus, body: { error: withReason(withRequestId(describeStatus(clientStatus), context), exception, context) } };
  }

  // Неопознанная ошибка наружу не раскрывается: детали уходят в лог, клиент
  // получает номер запроса, по которому находится запись.
  logger.error(`Необработанная ошибка${tag}`, exception instanceof Error ? exception.stack : String(exception));
  const body = withRequestId({ code: "internal_error", message: "Внутренняя ошибка сервера" }, context);
  return { status: 500, body: { error: withReason(body, exception, context) } };
}

/** Номер запроса получают все: он ничего не раскрывает. */
function withRequestId(body: ErrorBody, context: ErrorContext): ErrorBody {
  return context.requestId === null ? body : { ...body, requestId: context.requestId };
}

/**
 * Причина — первая строка текста исключения, без стека. Отдаётся, только если
 * сразу выполнены все три условия: маршрут панели, право `diagnostics.view`
 * у аккаунта и ошибка с общим текстом (сюда доходят только такие).
 */
function withReason(body: ErrorBody, exception: unknown, context: ErrorContext): ErrorBody {
  if (!reasonAllowed(context)) return body;
  const raw = exception instanceof Error ? exception.message : String(exception);
  const reason = (raw.split(/\r?\n/, 1)[0] ?? "").trim().slice(0, REASON_MAX_LENGTH);
  return reason === "" ? body : { ...body, reason };
}

function reasonAllowed(context: ErrorContext): boolean {
  const path = context.path.split("?", 1)[0] ?? "";
  return path.startsWith(ADMIN_PATH_PREFIX) && context.permissions?.has(REASON_PERMISSION) === true;
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
function describeStatus(status: number): ErrorBody {
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
