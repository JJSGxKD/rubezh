import { Controller, Get, Param, Req, Res } from "@nestjs/common";
import { z } from "zod";
import { Public } from "../../common/access.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { LINK_CODE } from "./link-code.js";
import { linkPage, notFoundPage } from "./link-page.js";
import { LinksService, type VisitorInfo } from "./links.service.js";

/**
 * `/r/<код>` — редирект-страница (docs/24-attribution-and-sharing.md §3). Не
 * под префиксом API: это адрес, который люди видят в чатах и постах, а Caddy
 * отдаёт `/r/*` бэкенду. Ответ — страница или переход, а не JSON-конверт.
 *
 * Открыта по сути: её открывает любой, кто кликнул. Защита — случайный код,
 * лимит по адресу и то, что клик ничего не даёт, кроме атрибуции.
 */

/** Ровно то, что нужно от ответа Fastify, — без его типов. */
interface PageReply {
  status(code: number): PageReply;
  header(name: string, value: string): PageReply;
  send(body?: string): unknown;
}

const VISITS_PER_MINUTE = { scope: "links:visit", limit: 120, windowSec: 60 } as const;

const text = z.string().trim().min(1).max(128).optional().catch(undefined);
const requestSchema = z.object({
  ip: z.string().optional().catch(undefined),
  headers: z
    .object({
      "user-agent": z.string().max(1024).optional().catch(undefined),
      referer: z.string().max(2048).optional().catch(undefined),
      "accept-language": z.string().max(256).optional().catch(undefined),
    })
    .catch({}),
  query: z
    .object({ utm_source: text, utm_medium: text, utm_campaign: text, utm_content: text, utm_term: text })
    .catch({}),
});

@Controller("r")
export class RedirectController {
  constructor(
    private readonly links: LinksService,
    private readonly limiter: RateLimiter,
  ) {}

  @Public()
  @Get(":code")
  async visit(@Param("code") code: string, @Req() request: unknown, @Res() reply: PageReply): Promise<void> {
    const html = (status: number, body: string, cache: string) =>
      void reply.status(status).header("content-type", "text/html; charset=utf-8").header("cache-control", cache).header("x-robots-tag", "noindex").send(body);

    if (!LINK_CODE.test(code)) return html(404, notFoundPage(), "no-store");
    const visitor = visitorOf(request);
    if (!(await this.limiter.consume(VISITS_PER_MINUTE, visitor.ip ?? "unknown"))) return html(429, notFoundPage(), "no-store");

    const visit = await this.links.visit(code, visitor);
    if (visit.kind === "not_found") return html(404, notFoundPage(), "no-store");
    // Превью краулеру кешируется: мессенджеры спрашивают страницу повторно.
    if (visit.kind === "preview") return html(200, linkPage({ url: visit.url, target: null }), "public, max-age=300");
    if (visit.kind === "unavailable") return html(503, linkPage({ url: visit.url, target: null }), "no-store");
    void reply.status(302).header("location", visit.target).header("cache-control", "no-store").send();
  }
}

function visitorOf(request: unknown): VisitorInfo {
  const parsed = requestSchema.safeParse(request);
  const value = parsed.success ? parsed.data : { ip: undefined, headers: {}, query: {} };
  const { headers, query } = value;
  return {
    userAgent: headers["user-agent"] ?? null,
    referer: headers.referer ?? null,
    acceptLanguage: headers["accept-language"] ?? null,
    ip: value.ip ?? null,
    utm: {
      source: query.utm_source ?? null,
      medium: query.utm_medium ?? null,
      campaign: query.utm_campaign ?? null,
      content: query.utm_content ?? null,
      term: query.utm_term ?? null,
    },
  };
}
