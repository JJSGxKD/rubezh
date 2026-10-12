import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Module, type Type } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { ValidationError } from "../src/common/domain-error.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { LinkNotFoundError } from "../src/modules/admin/admin-errors.js";
import { AdminLinksController } from "../src/modules/admin/admin-links.controller.js";
import type { ConversionsJournal } from "../src/modules/ad-conversions/conversions-journal.service.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { isCrawler } from "../src/modules/links/crawler.js";
import { escapeHtml, linkPage } from "../src/modules/links/link-page.js";
import type { LinkTarget } from "../src/modules/links/link-targets.js";
import { LINKS_REPOSITORY, type ClickInput, type LinkInput, type LinkRecord, type LinksRepository, type LinkStats } from "../src/modules/links/links.repository.js";
import { hostOf, languageOf, LinksService, type VisitorInfo } from "../src/modules/links/links.service.js";
import { RedirectController } from "../src/modules/links/redirect.controller.js";
import type { AuditEntry } from "../src/modules/roles/roles.repository.js";
import type { RolesService } from "../src/modules/roles/roles.service.js";
import type { SecretsService } from "../src/modules/secrets/secrets.service.js";
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
    const record = { ...link, target: link.target ?? "app", createdAt: new Date() };
    this.links.set(link.code, record);
    return record;
  }
  async retarget(code: string, target: LinkTarget): Promise<LinkRecord | null> {
    const link = this.links.get(code);
    if (link === undefined) return null;
    const next = { ...link, target };
    this.links.set(code, next);
    return next;
  }
  async byCode(code: string): Promise<LinkRecord | null> {
    return this.links.get(code) ?? null;
  }
  async recordClick(click: ClickInput): Promise<void> {
    this.clicks.push(click);
  }
  async list(): Promise<LinkStats[]> {
    return [...this.links.values()].map((link) => ({ ...link, clicks: this.clicks.filter((click) => click.linkCode === link.code).length, clicks30d: 0, launches: 0, directLaunches: 0 }));
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
let botUsername: string | null;
let service: LinksService;

function visitor(patch: Partial<VisitorInfo> = {}): VisitorInfo {
  return {
    userAgent: HUMAN,
    referer: "https://t.me/s/rubezh_channel?before=1",
    acceptLanguage: "ru-RU,ru;q=0.9",
    ip: "198.51.100.7",
    utm: { source: "tg", medium: null, campaign: "launch", content: null, term: null },
    query: {},
    ...patch,
  };
}

function telegramLinks(): AppLinks {
  return new AppLinks([
    new TelegramAppLinks({
      get miniAppLink() {
        return miniApp;
      },
      get username() {
        return botUsername;
      },
    }),
  ]);
}

beforeEach(() => {
  repository = new MemoryLinks();
  miniApp = "https://t.me/rubezh_bot?startapp";
  botUsername = "rubezh_bot";
  const appLinks = telegramLinks();

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

  it("ссылка AdsGram: адрес с макросами для кабинета, подставленные сетью значения — на клике", async () => {
    const link = await service.create({ accountId: "a1", platform: "telegram", platformUserId: "1" }, { campaign: "ag-oct", source: "adsgram", medium: null, note: null, platform: "telegram", network: "adsgram" });
    // Макросы — буквально: сеть ищет `{campaign_id}`, а не `%7Bcampaign_id%7D`.
    expect(link.networkUrl).toBe(`https://rubezh.example/r/${link.code}?campaign={campaign_id}&banner={banner_id}&pub={publisher_id}&clickid={click_id}&record={record_data}`);
    expect(link.registrationOn).toBe("first_run");

    await service.visit(link.code, visitor({ query: { campaign: "1234", banner: "77", record: "7f3a1b6c5d2e4f8a", clickid: "{click_id}", other: "x" } }));
    await new Promise((resolve) => setImmediate(resolve));
    // Неподставленный макрос — превью кабинета, а не клик сети: он отбрасывается, как и чужие параметры.
    expect(repository.clicks[0]?.networkParams).toEqual({ campaign: "1234", banner: "77", record: "7f3a1b6c5d2e4f8a" });
  });

  it("обычная ссылка параметров сети не хранит, а макросов без подстановки — нет и на ссылке сети", async () => {
    const plain = await service.create({ accountId: "a1", platform: "telegram", platformUserId: "1" }, { campaign: "c", source: null, medium: null, note: null, platform: "telegram" });
    expect(plain.networkUrl).toBeNull();
    await service.visit(plain.code, visitor({ query: { record: "abc" } }));
    const network = await service.create({ accountId: "a1", platform: "telegram", platformUserId: "1" }, { campaign: "c", source: null, medium: null, note: null, platform: "telegram", network: "adsgram" });
    await service.visit(network.code, visitor({ query: { campaign: "{campaign_id}", record: "{record_data}" } }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(repository.clicks.map((click) => click.networkParams)).toEqual([null, null]);
  });

  it("заводить и смотреть ссылки — только с правом", async () => {
    const guarded = new LinksService(config(), repository, new AppLinks([]), deny);
    await expect(guarded.create({ accountId: "a1", platform: "telegram", platformUserId: "1" }, { campaign: "c", source: null, medium: null, note: null, platform: "telegram" })).rejects.toThrow("нет права");
    await expect(guarded.list({ accountId: "a1", platform: "telegram", platformUserId: "1" })).rejects.toThrow("нет права");
  });
});

describe("цель ссылки и прямая ссылка", () => {
  const actor = { accountId: "a1", platform: "telegram" as const, platformUserId: "1" };
  const plain = { campaign: "c", source: null, medium: null, note: null, platform: "telegram" as const };
  let audits: AuditEntry[];
  let guarded: LinksService;

  beforeEach(() => {
    audits = [];
    const recording = {
      require: async () => undefined,
      audit: async (entry: AuditEntry) => {
        audits.push(entry);
      },
    } as unknown as RolesService;
    guarded = new LinksService(config(), repository, telegramLinks(), recording);
  });

  async function redirectOf(code: string): Promise<string> {
    const visit = await guarded.visit(code, visitor());
    expect(visit.kind).toBe("redirect");
    return visit.kind === "redirect" ? visit.target : "";
  }

  it("без цели ссылка ведёт в Mini App, а в виде — прямая ссылка l-<код>", async () => {
    const link = await guarded.create(actor, plain);
    expect(link.target).toBe("app");
    expect(link.directUrl).toBe(`https://t.me/rubezh_bot?startapp=l-${link.code}`);
    expect(await redirectOf(link.code)).toMatch(/^https:\/\/t\.me\/rubezh_bot\?startapp=c-[A-Za-z0-9]{12}$/);
  });

  it("цель «бот»: переходник ведёт в чат с c-<клик>, прямая ссылка — в чат с l-<код>", async () => {
    const link = await guarded.create(actor, { ...plain, target: "bot" });
    expect(link.target).toBe("bot");
    expect(link.directUrl).toBe(`https://t.me/rubezh_bot?start=l-${link.code}`);
    expect(await redirectOf(link.code)).toMatch(/^https:\/\/t\.me\/rubezh_bot\?start=c-[A-Za-z0-9]{12}$/);
    await new Promise((resolve) => setImmediate(resolve));
    expect(repository.clicks).toHaveLength(1);
  });

  it("цель «лендинг»: переходник ведёт на домен переходника с ?c=<клик>, прямая ссылка — с ?l=<код>", async () => {
    const link = await guarded.create(actor, { ...plain, target: "landing" });
    expect(link.directUrl).toBe(`https://rubezh.example/?l=${link.code}`);
    const target = await redirectOf(link.code);
    expect(target).toMatch(/^https:\/\/rubezh\.example\/\?c=[A-Za-z0-9]{12}$/);
    await new Promise((resolve) => setImmediate(resolve));
    expect(target.endsWith(`c=${repository.clicks[0]?.clickId}`)).toBe(true);
  });

  it("у ссылки сети прямой ссылки нет при любой цели", async () => {
    for (const target of ["app", "bot", "landing"] as const) {
      const link = await guarded.create(actor, { ...plain, target, network: "adsgram" });
      expect(link.directUrl, target).toBeNull();
      expect(link.networkUrl).not.toBeNull();
    }
  });

  it("бот ещё не представился: прямой ссылки нет, переход — «недоступно», клика нет", async () => {
    const app = await guarded.create(actor, plain);
    const chat = await guarded.create(actor, { ...plain, target: "bot" });
    miniApp = null;
    botUsername = null;
    expect((await guarded.list(actor)).map((link) => link.directUrl)).toEqual([null, null]);
    expect((await guarded.visit(app.code, visitor())).kind).toBe("unavailable");
    expect((await guarded.visit(chat.code, visitor())).kind).toBe("unavailable");
    await new Promise((resolve) => setImmediate(resolve));
    expect(repository.clicks).toEqual([]);
  });

  it("retarget: цель меняется, в аудите «было → стало»; новые клики идут по-новому, прошлые остаются", async () => {
    const link = await guarded.create(actor, plain);
    await redirectOf(link.code);
    await new Promise((resolve) => setImmediate(resolve));

    const changed = await guarded.retarget(actor, link.code, "bot");
    expect(changed).toMatchObject({ code: link.code, target: "bot", directUrl: `https://t.me/rubezh_bot?start=l-${link.code}` });
    expect(audits.at(-1)).toEqual({ actorAccountId: "a1", action: "links.retarget", target: link.code, before: { target: "app" }, after: { target: "bot" } });

    expect(await redirectOf(link.code)).toMatch(/\?start=c-/);
    await new Promise((resolve) => setImmediate(resolve));
    expect(repository.clicks).toHaveLength(2);
  });

  it("retarget без права links.manage — отказ, цель не меняется, аудита нет", async () => {
    const link = await guarded.create(actor, plain);
    audits = [];
    const denied = new LinksService(config(), repository, telegramLinks(), deny);
    await expect(denied.retarget(actor, link.code, "landing")).rejects.toThrow("нет права");
    expect(repository.links.get(link.code)?.target).toBe("app");
    expect(audits).toEqual([]);
  });

  it("retarget несуществующей ссылки — null, аудита нет", async () => {
    expect(await guarded.retarget(actor, "NoSuchCode9", "bot")).toBeNull();
    expect(audits).toEqual([]);
  });
});

describe("ссылки в панели: цель", () => {
  const request = { account: { accountId: "a1", platform: "telegram", platformUserId: "1" } };

  function controller(): AdminLinksController {
    const journal = { summaries: async () => new Map() } as unknown as ConversionsJournal;
    const limiter = { consume: async () => true } as unknown as RateLimiter;
    const secrets = { get: () => null } as unknown as SecretsService;
    return new AdminLinksController(service, journal, secrets, limiter);
  }

  it("создание принимает цель, без неё — Mini App; цель не из списка — ошибка границы", async () => {
    const panel = controller();
    expect((await panel.create(request, { campaign: "launch" })).data.target).toBe("app");
    const bot = (await panel.create(request, { campaign: "launch", target: "bot" })).data;
    expect(bot).toMatchObject({ target: "bot", directUrl: `https://t.me/rubezh_bot?start=l-${bot.code}` });
    await expect(panel.create(request, { campaign: "launch", target: "email" })).rejects.toThrow(ValidationError);
  });

  it("PATCH меняет цель и отвечает записью с новой прямой ссылкой", async () => {
    const panel = controller();
    const link = (await panel.create(request, { campaign: "launch" })).data;
    const changed = (await panel.retarget(request, link.code, { target: "landing" })).data;
    expect(changed).toMatchObject({ code: link.code, target: "landing", directUrl: `https://rubezh.example/?l=${link.code}` });
    expect(repository.links.get(link.code)?.target).toBe("landing");
  });

  it("PATCH: цель не из списка или без неё — ошибка границы; ссылки с таким кодом нет — 404", async () => {
    const panel = controller();
    const link = (await panel.create(request, { campaign: "launch" })).data;
    await expect(panel.retarget(request, link.code, { target: "email" })).rejects.toThrow(ValidationError);
    await expect(panel.retarget(request, link.code, {})).rejects.toThrow(ValidationError);
    await expect(panel.retarget(request, "NoSuchCode9", { target: "bot" })).rejects.toThrow(LinkNotFoundError);
    // Код не того вида до ссылки не доходит.
    await expect(panel.retarget(request, "../etc", { target: "bot" })).rejects.toThrow(LinkNotFoundError);
    expect(repository.links.get(link.code)?.target).toBe("app");
  });

  it("список отдаёт цель, прямую ссылку и прямые запуски; у ссылки сети прямой нет", async () => {
    const panel = controller();
    await panel.create(request, { campaign: "launch", target: "bot" });
    await panel.create(request, { campaign: "ag", network: "adsgram" });
    const rows = (await panel.list(request)).data.links;
    expect(rows.map((row) => [row.target, row.directUrl === null, row.directLaunches])).toEqual([
      ["bot", false, 0],
      ["app", true, 0],
    ]);
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

    // Ссылка сети: переходник передаёт макросы как пришли — профиль сети разберёт их сам.
    const network = await service.create({ accountId: "a1", platform: "telegram", platformUserId: "1" }, { campaign: "ag", source: null, medium: null, note: null, platform: "telegram", network: "adsgram" });
    const fromAd = await target.inject({ method: "GET", url: `/r/${network.code}?campaign=55&record=ab12cd34&pub=9`, headers: { "user-agent": HUMAN } });
    expect(fromAd.statusCode).toBe(302);
    await new Promise((resolve) => setImmediate(resolve));
    expect(repository.clicks.at(-1)?.networkParams).toEqual({ campaign: "55", pub: "9", record: "ab12cd34" });

    const bot = await target.inject({ method: "GET", url: `/r/${link.code}`, headers: { "user-agent": "TelegramBot (like TwitterBot)" } });
    expect(bot.statusCode).toBe(200);
    expect(bot.headers["content-type"]).toContain("text/html");
    expect(bot.body).toContain("og:title");

    expect((await target.inject({ method: "GET", url: "/r/NoSuchCode9", headers: { "user-agent": HUMAN } })).statusCode).toBe(404);
    expect((await target.inject({ method: "GET", url: "/r/../etc", headers: { "user-agent": HUMAN } })).statusCode).toBe(404);
  });
});
