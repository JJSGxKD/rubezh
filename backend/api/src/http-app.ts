import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { APP_CONFIG, type AppConfig } from "./config/app-config.js";
import { DomainErrorFilter } from "./common/domain-error.filter.js";
import { API_SECURITY_HEADERS } from "./common/security-headers.js";

/**
 * Сборка HTTP-приложения — одна для `main.ts` и HTTP-тестов: префикс,
 * фильтр ошибок, лимит тела и CORS в тестах те же, что в проде, а не их копия.
 *
 * Платформа — Fastify (docs/16-tech-stack-decisions.md §5): одна на весь
 * бэкенд, второй платформы рядом не держим.
 */

/**
 * Верхняя граница тела запроса. Самое большое, что сейчас приходит, —
 * отчёт стресс-теста: до 600 корзин таймлайна, это сотни килобайт. Без
 * границы эндпоинт превращается в приём произвольных объёмов данных.
 */
export const BODY_LIMIT_BYTES = 2 * 1024 * 1024;

type EntryModule = Parameters<typeof NestFactory.create>[0];

export interface HttpAppOptions {
  logger?: boolean;
  /** сколько прокси перед API — `TRUST_PROXY_HOPS`; Fastify нужно знать это до создания */
  trustProxyHops?: number;
}

export async function createHttpApp(module: EntryModule, options: HttpAppOptions = {}): Promise<NestFastifyApplication> {
  const hops = options.trustProxyHops ?? 0;
  const adapter = new FastifyAdapter({
    bodyLimit: BODY_LIMIT_BYTES,
    // Доверяем ровно стольким ближайшим прокси, сколько их перед API: адрес
    // из X-Forwarded-For дальше этой цепочки — слова клиента, а не факт.
    trustProxy: hops > 0 ? (_address: string, hop: number) => hop < hops : false,
  });
  const app = await NestFactory.create<NestFastifyApplication>(module, adapter, options.logger === false ? { logger: false } : {});
  configureHttpApp(app, app.get<AppConfig>(APP_CONFIG));
  return app;
}

function configureHttpApp(app: NestFastifyApplication, config: AppConfig): void {
  // Ошибки разбора тела — битый JSON, тело сверх лимита — Nest передаёт
  // этому же фильтру, поэтому клиент получает их в общей форме, а не в форме
  // ответа Fastify (проверяет test/http-app.test.ts).
  app.useGlobalFilters(new DomainErrorFilter());

  // health остаётся на корне: пробы и мониторинг не должны знать о версии API.
  // `/r/<код>` — адрес редирект-ссылки в чатах и постах, а не API
  // (docs/24-attribution-and-sharing.md §3.1).
  app.setGlobalPrefix("api/v1", { exclude: ["health", "r/:code", "r/:code/card.png"] });

  app.enableCors({
    origin: config.allowedOrigins.length > 0 ? config.allowedOrigins : false,
    credentials: true,
  });

  // Заголовки безопасности — на каждый ответ, в том числе на ошибки: ответ
  // с 401 тоже не должен ни кешироваться, ни встраиваться
  // (common/security-headers.ts). Маршрут, выставивший свой заголовок сам,
  // остаётся при своём: общая защита не должна молча перебивать решение,
  // принятое в конкретном месте.
  app
    .getHttpAdapter()
    .getInstance()
    .addHook("onSend", async (_request, reply, payload) => {
      for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
        if (!reply.hasHeader(name)) reply.header(name, value);
      }
      return payload;
    });
}
