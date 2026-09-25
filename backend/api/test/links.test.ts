import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Module, type Type } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { isCrawler } from "../src/modules/links/crawler.js";
import { escapeHtml, linkPage } from "../src/modules/links/link-page.js";
import { LINKS_REPOSITORY, type ClickInput, type LinkInput, type LinkRecord, type LinksRepository, type LinkStats } from "../src/modules/links/links.repository.js";
import { hostOf, languageOf, LinksService, type VisitorInfo } from "../src/modules/links/links.service.js";
import { RedirectController } from "../src/modules/links/redirect.controller.js";
import type { RolesService } from "../src/modules/roles/roles.service.js";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { TelegramAppLinks } from "../src/platforms/telegram/telegram-app-links.js";

/**
 * Редирект-ссылки (docs/24-attribution-and-sharing.md §3): краулер получает
 * превью и кликом не считается, человек уходит в приложение с кодом клика в
 * параметре запуска, неизвестная ссылка — 404, а `/r/<код>` живёт вне префикса API.
 */

const HUMAN = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";

class MemoryLinks implements LinksRepository {
  readonly links = new Map<string, LinkRecord>();
  readonly clicks: ClickInput[] = [];
  async create(link: LinkInput): Promise<LinkRecord> {
    const record = { ...link, createdAt: new Date() };
    this.links.set(link.code, record);
    return record;
  }
  async byCode(code: string): Promise<LinkRecord | null> {
    return this.links.get(code) ?? null;
  }
  async recordClick(click: ClickInput): Promise<void> {
    this.clicks.push(click);
  }
  async list(): Promise<LinkStats[]> {
    return [...this.links.values()].map((link) => ({ ...link, clicks: this.clicks.filter((click) => click.linkCode === link.code).length, clicks30d: 0, launches: 0 }));
  }
}

function config(env: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", PUBLIC_WEB_URL: "https://rubezh.example", ...env } as NodeJS.ProcessEnv);
}

const allow = { require: async () => undefined, audit: async () => undefined } as unknown as RolesService;
const deny = {
  require: async () => {
    throw Object.assign(new Error("нет права"), { code: "forbidden" });
  },
} as unknown as RolesService;

let repository: MemoryLinks;
let miniApp: string | null;
let service: LinksService;

function visitor(patch: Partial<VisitorInfo> = {}): VisitorInfo {
  return { userAgent: HUMAN, referer: "https://t.me/s/rubezh_channel?before=1", acceptLanguage: "ru-RU,ru;q=0.9", ip: "198.51.100.7", utm: { source: "tg", medium: null, campaign: "launch", content: null, term: null }, ...patch };
}

beforeEach(() => {
  repository = new MemoryLinks();
  miniApp = "https://t.me/rubezh_bot?startapp";
  const appLinks = new AppLinks([new TelegramAppLinks({ get miniAppLink() { return miniApp; } })]);
  service = new LinksService(config(), repository, appLinks, allow);
});

describe("краулеры превью", () => {
  it("боты мессенджеров и поисковиков — краулеры, браузер — нет", () => {
    for (const agent of ["TelegramBot (like TwitterBot)", "WhatsApp/2.23.20.0", "facebookexternalhit/1.1", "Mozilla/5.0 (compatible; vkShare; +http://vk.com/dev/Share)", "Discordbot/2.0", "Twitterbot/1.0", "", null]) {
      expect(isCrawler(agent), String(agent)).toBe(true);
    }
    expect(isCrawler(HUMAN)).toBe(false);
  });
});

describe("переход по ссылке", () => {
  it("человек уходит в приложение с кодом клика; клик пишется без лишних данных", async () => {
    const link = await service.create({ accountId: "a1", platform: "telegram", platformUserId: "1" }, { campaign: "launch", source: "tg", medium: null, note: null, platform: "telegram" });
    expect(link.url).toBe(`https://rubezh.example/r/${link.code}`);

    const visit = await service.visit(link.code, visitor());
    expect(visit.kind).toBe("redirect");
    const target = visit.kind === "redirect" ? visit.target : "";
    expect(target).toMatch(/^https:\/\/t\.me\/rubezh_bot\?startapp=c-[A-Za-z0-9]{12}$/);
    await new Promise((resolve) => setImmediate(resolve));
    expect(repository.clicks[0]).toMatchObject({ linkCode: link.code, refererHost: "t.me", language: "ru-RU", ipPrefix: "198.51.100.0/24", deviceClass: "mobile", utm: { campaign: "launch" } });
    expect(target.endsWith(`c-${repository.clicks[0]?.clickId}`)).toBe(true);
  });

  it("краулер получает превью и кликом не считается; неизвестная ссылка — не найдена", async () => {
    const link = await service.create({ accountId: "a1", platform: "telegram", platformUserId: "1" }, { campaign: "c", source: null, medium: null, note: null, platform: "telegram" });
    expect(await service.visit(link.code, visitor({ userAgent: "TelegramBot (like TwitterBot)" }))).toEqual({ kind: "preview", url: `https://rubezh.example/r/${link.code}` });
    expect(await service.visit("NoSuchCode9", visitor())).toEqual({ kind: "not_found" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(repository.clicks).toEqual([]);
  });

  it("бот ещё не представился — страница вместо перехода, клика нет", async () => {
    const link = await service.create({ accountId: "a1", platform: "telegram", platformUserId: "1" }, { campaign: "c", source: null, medium: null, note: null, platform: "telegram" });
    miniApp = null;
    expect((await service.visit(link.code, visitor())).kind).toBe("unavailable");
    expect(repository.clicks).toEqual([]);
  });

  it("заводить и смотреть ссылки — только с правом", async () => {
    const guarded = new LinksService(config(), repository, new AppLinks([]), deny);
    await expect(guarded.create({ accountId: "a1", platform: "telegram", platformUserId: "1" }, { campaign: "c", source: null, medium: null, note: null, platform: "telegram" })).rejects.toThrow("нет права");
    await expect(guarded.list({ accountId: "a1", platform: "telegram", platformUserId: "1" })).rejects.toThrow("нет права");
  });
});

describe("разбор посетителя и страница", () => {
  it("от Referer — только хост, от Accept-Language — первый язык", () => {
    expect(hostOf("https://t.me/s/channel?x=1")).toBe("t.me");
    expect(hostOf("не адрес")).toBeNull();
    expect(languageOf("ru-RU,ru;q=0.9,en;q=0.8")).toBe("ru-RU");
    expect(languageOf("*")).toBeNull();
  });

  it("страница превью экранирует адрес и несёт OG-теги", () => {
    const page = linkPage({ url: `https://x.example/r/"><script>`, target: null });
    expect(page).toContain('property="og:title"');
    expect(page).not.toContain("<script>");
    expect(escapeHtml(`<a href="x">`)).toBe("&lt;a href=&quot;x&quot;&gt;");
  });
});

describe("HTTP /r/:code", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(): Promise<NestFastifyApplication> {
    @Module({
      controllers: [RedirectController],
      providers: [
        { provide: APP_CONFIG, useValue: config() },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: LINKS_REPOSITORY, useValue: repository },
        { provide: LinksService, useValue: service },
        RateLimiter,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule as Type<unknown>, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
  }

  it("живёт вне префикса API: человеку — 302, краулеру — страница, мусору — 404", async () => {
    const target = await start();
    const link = await service.create({ accountId: "a1", platform: "telegram", platformUserId: "1" }, { campaign: "c", source: null, medium: null, note: null, platform: "telegram" });

    const human = await target.inject({ method: "GET", url: `/r/${link.code}?utm_source=tg`, headers: { "user-agent": HUMAN } });
    expect(human.statusCode).toBe(302);
    expect(human.headers.location).toMatch(/startapp=c-/);

    const bot = await target.inject({ method: "GET", url: `/r/${link.code}`, headers: { "user-agent": "TelegramBot (like TwitterBot)" } });
    expect(bot.statusCode).toBe(200);
    expect(bot.headers["content-type"]).toContain("text/html");
    expect(bot.body).toContain("og:title");

    expect((await target.inject({ method: "GET", url: "/r/NoSuchCode9", headers: { "user-agent": HUMAN } })).statusCode).toBe(404);
    expect((await target.inject({ method: "GET", url: "/r/../etc", headers: { "user-agent": HUMAN } })).statusCode).toBe(404);
  });
});
