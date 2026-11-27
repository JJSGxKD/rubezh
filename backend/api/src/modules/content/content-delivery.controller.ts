import { Controller, Get, Param, Query, Req, Res, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { Public } from "../../common/access.js";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { ContentVersionNotFoundError } from "./content-errors.js";
import { ContentDeliveryService, type CurrentVersion } from "./content-delivery.service.js";

/**
 * Версия контента для клиента (`/api/v1/content`, docs/19-content-admin.md §3,
 * tasks/T-0306): какая версия у игрока и снимок по хэшу.
 *
 * `current` — под токеном: аудиторию («команда» или все) сервер берёт из
 * сессии, а не из запроса. Снимок — открыт: адрес — хэш содержимого, которого
 * не угадать, а версии, не бывавшие в игре, не отдаются вовсе. Ответ один у
 * всех, поэтому его снимает с сервера CDN: заголовок вечного кеша тот же, что
 * у картинок из панели (`media/media-reply.ts`), а сжатие делает край (Caddy,
 * `encode zstd gzip` в `infra/prod/Caddyfile`).
 */

const CURRENT: RateLimit = { scope: "content:current", limit: 60, windowSec: 60 };
const LOOKUPS: RateLimit = { scope: "content:lookup", limit: 120, windowSec: 60 };

/** Схема формы снимка — целое, как `schemaVersion` версии (`SMALLINT`). */
const schemaSchema = z.coerce.number().int().min(1).max(32_767);
const SNAPSHOT_FILE = /^([0-9a-f]{8,64})\.json$/;
const requestSchema = z
  .object({
    ip: z.string().max(64).optional().catch(undefined),
    headers: z.object({ "if-none-match": z.string().max(256).optional().catch(undefined) }).catch({}),
  })
  .catch({ headers: {} });

/** Ровно то, что нужно от ответа Fastify, — без его типов. */
interface SnapshotReply {
  status(code: number): SnapshotReply;
  header(name: string, value: string): SnapshotReply;
  send(payload?: string): unknown;
}

@Controller("content")
export class ContentDeliveryController {
  constructor(
    private readonly delivery: ContentDeliveryService,
    private readonly limiter: RateLimiter,
  ) {}

  @UseGuards(AuthGuard)
  @Get("current")
  async current(@Req() request: unknown, @Query("schema") schema: unknown): Promise<{ data: CurrentVersion | null }> {
    const parsed = schemaSchema.safeParse(schema);
    if (!parsed.success) throw new ValidationError("Нужна версия схемы клиента: ?schema=<целое от 1>");
    const account = accountOf(request);
    if (!(await this.limiter.consume(CURRENT, account.accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
    return { data: await this.delivery.current(account, parsed.data) };
  }

  @Public()
  @Get("v/:file")
  async snapshot(@Param("file") file: string, @Req() request: unknown, @Res() reply: SnapshotReply): Promise<void> {
    const hash = SNAPSHOT_FILE.exec(file)?.[1];
    if (hash === undefined) throw new ContentVersionNotFoundError("Снимка с таким адресом нет");
    const asked = requestSchema.parse(request);
    let body = this.delivery.peek(hash);
    if (body === undefined) {
      // В базу ходит только то, чего нет в памяти реплики, — это и ограничено: перебор хэшей упрётся в лимит.
      if (!(await this.limiter.consume(LOOKUPS, asked.ip ?? "unknown"))) throw new RateLimitedError("Слишком часто — попробуйте позже");
      const read = await this.delivery.snapshot(hash);
      if (read === null) throw new ContentVersionNotFoundError("Снимка с таким адресом нет");
      body = read;
    }
    const etag = `"${hash}"`;
    reply.header("cache-control", "public, max-age=31536000, immutable").header("etag", etag).header("x-content-type-options", "nosniff");
    const match = asked.headers["if-none-match"];
    if (match !== undefined && match.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag)) {
      reply.status(304).send();
      return;
    }
    reply.status(200).header("content-type", "application/json; charset=utf-8").send(body);
  }
}
