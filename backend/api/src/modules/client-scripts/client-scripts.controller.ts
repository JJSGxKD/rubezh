import { Controller, Get, Req, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { Public } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { addressOf } from "../../common/request-address.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { ClientScripts } from "./client-scripts.service.js";

/**
 * Какие чужие скрипты клиент вправе грузить. Открыт по сути: клиент спрашивает
 * до входа, а секрета в ответе нет. Ответ один у всех, поэтому его снимает с
 * сервера CDN (docs/20-env-and-ports.md §2.2).
 */
const LIMIT: RateLimit = { scope: "client-scripts", limit: 60, windowSec: 60 };

@Controller("client")
export class ClientScriptsController {
  constructor(
    private readonly scripts: ClientScripts,
    private readonly limiter: RateLimiter,
  ) {}

  @Public()
  @Get("scripts")
  async list(@Req() request: unknown, @Res({ passthrough: true }) reply: FastifyReply): Promise<{ data: { graspil: boolean } }> {
    if (!(await this.limiter.consume(LIMIT, addressOf(request)))) throw new RateLimitedError("Слишком много запросов — попробуй позже");
    void reply.header("cache-control", "public, max-age=60");
    return { data: { graspil: this.scripts.graspil() } };
  }
}
