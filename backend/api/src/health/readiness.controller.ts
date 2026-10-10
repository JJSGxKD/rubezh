import { Controller, Get, Inject, Req, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { Redis } from "ioredis";
import { Public } from "../common/access.js";
import { RateLimitedError } from "../common/domain-error.js";
import { withTimeout } from "../common/with-timeout.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { PRISMA } from "../infra/database.js";
import { REDIS } from "../infra/redis.js";
import { RateLimiter, type RateLimit } from "../modules/ingest/rate-limiter.js";

/** Сколько ждать ответа хранилища: проба Docker ждёт 5 секунд, обе проверки идут параллельно. */
const CHECK_TIMEOUT_MS = 1_000;
/** Внешней проверке хватит одного запроса в 5 минут; лимит не даёт заваливать базу через публичный путь. */
const READY_LIMIT: RateLimit = { scope: "health:ready", limit: 60, windowSec: 60 };

type CheckResult = "ok" | "fail";

export interface Readiness {
  status: "ok" | "degraded";
  checks: { postgres: CheckResult; redis: CheckResult };
}

/**
 * Готовность API: достаёт ли он до своих хранилищ. Отдельно от `/health`
 * (жив ли процесс), чтобы тестам HTTP-слоя без базы эти зависимости не
 * понадобились. Ответ публичный, поэтому в нём нет текста ошибок и адресов —
 * только «ок» или «не ок» по каждому хранилищу.
 */
@Controller("health")
export class ReadinessController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly limiter: RateLimiter,
  ) {}

  @Public()
  @Get("ready")
  async ready(@Req() request: unknown, @Res({ passthrough: true }) reply: FastifyReply): Promise<Readiness> {
    const allowed = await this.limiter.consume(READY_LIMIT, addressOf(request));
    if (!allowed) throw new RateLimitedError("Слишком часто — подождите минуту");

    const [postgres, redis] = await Promise.all([
      check(async () => this.prisma.$queryRaw`SELECT 1`, "postgres"),
      check(async () => this.redis.ping(), "redis"),
    ]);
    const healthy = postgres === "ok" && redis === "ok";
    if (!healthy) void reply.status(503);
    return { status: healthy ? "ok" : "degraded", checks: { postgres, redis } };
  }
}

async function check(probe: () => Promise<unknown>, label: string): Promise<CheckResult> {
  try {
    await withTimeout(probe(), CHECK_TIMEOUT_MS, label);
    return "ok";
  } catch {
    // Причина публично не отдаётся; для разбора хватает самого факта и логов базы/Redis.
    return "fail";
  }
}

/** Адрес из `req.ip` Fastify: он учитывает число доверенных прокси, а сырой заголовок подделывается одной строкой. */
function addressOf(request: unknown): string {
  const ip = (request as { ip?: unknown }).ip;
  return typeof ip === "string" && ip !== "" ? ip : "unknown";
}
