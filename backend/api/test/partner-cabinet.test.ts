import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { AdminCabinetController } from "../src/modules/admin/admin-cabinet.controller.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminSessionController } from "../src/modules/admin/admin-session.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE } from "../src/modules/admin/admin-session.store.js";
import { PanelLoginService } from "../src/modules/admin/panel-login.service.js";
import { PANEL_LOGIN_STORE } from "../src/modules/admin/panel-login.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import type { LinkInput, LinkRecord, LinksRepository, LinkStats } from "../src/modules/links/links.repository.js";
import { PartnerCabinet, campaignSlug, type PartnerPromos } from "../src/modules/partners/partner-cabinet.js";
import { PartnerNotFoundError } from "../src/modules/partners/partner-errors.js";
import { codeKey } from "../src/modules/promo-codes/promo-code-rules.js";
import type { NewPromoCampaign } from "../src/modules/promo-codes/promo-codes.repository.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { TelegramAppLinks } from "../src/platforms/telegram/telegram-app-links.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryPanelLoginStore } from "./helpers/memory-panel-login.js";
import { MemoryPartnerAccounts } from "./helpers/memory-partner-accounts.js";
import { MemoryPartnersRepository } from "./helpers/memory-partners.js";
import { MemoryPromoCodesRepository } from "./helpers/memory-promo-codes.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Ссылки и промокоды кабинета партнёра (docs/35-stage4-plan.md Р136, tasks/T-0218): партнёр видит и заводит
 * только своё — ссылки в пределах лимита, промокоды копией своей кампании с новым словом, без права
 * `links.manage` и `promo.edit`. Права и чужой кабинет решает `PartnerCabinet.partnerOf` (T-0217).
 */

const NOW = new Date(Date.UTC(2026, 9, 24, 9));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OWNER_ID = "777000444";

/** Ссылки в памяти: ровно то, что кабинету нужно от репозитория ссылок. */
class MemoryLinks implements LinksRepository {
  readonly links = new Map<string, LinkRecord>();
  readonly partners = new Map<string, string>();
  clicks = new Map<string, number>();
  async create(link: LinkInput): Promise<LinkRecord> {
    const { partnerId, ...rest } = link;
    if (partnerId != null && !this.partners.has(partnerId)) throw new PartnerNotFoundError();
    const record: LinkRecord = {
      ...rest,
      target: link.target ?? "app",
      partner: partnerId == null ? null : { partnerId, name: this.partners.get(partnerId) ?? "" },
      createdAt: NOW,
      auto: false,
      autoKey: null,
      partnerTag: null,
      title: null,
      hiddenAt: null,
      postbackUrl: null,
      postbackSince: null,
      postbackEvents: ["registration"],
    };
    this.links.set(link.code, record);
    return record;
  }
  async partnerName(partnerId: string): Promise<string | null> {
    return this.partners.get(partnerId) ?? null;
  }
  async byCode(code: string): Promise<LinkRecord | null> {
    return this.links.get(code) ?? null;
  }
  async list(_limit: number, filter: { partnerId?: string } = {}): Promise<LinkStats[]> {
    return [...this.links.values()]
      .filter((link) => filter.partnerId === undefined || link.partner?.partnerId === filter.partnerId)
      .map((link) => ({ ...link, clicks: this.clicks.get(link.code) ?? 0, clicks30d: 0, launches: 2, directLaunches: 1, devices: { mobile: 0, desktop: 0, web: 0, unknown: 0 } }));
  }
  async retarget(): Promise<LinkRecord | null> {
    return null;
  }
  async setDisplay(): Promise<LinkRecord | null> {
    return null;
  }
  async setPostback(): Promise<LinkRecord | null> {
    return null;
  }
  async recordClick(): Promise<void> {}
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error("ожидался отказ");
}

function setup() {
  const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID, PUBLIC_WEB_URL: "https://rubezh.example" } as NodeJS.ProcessEnv);
  const accounts = new MemoryAccountRepository();
  const roles = new MemoryRolesRepository();
  const promo = new MemoryPromoCodesRepository();
  const partners = new MemoryPartnersRepository(promo);
  const linked = new MemoryPartnerAccounts(accounts, partners);
  const links = new MemoryLinks();
  const settings = panelSettings();
  const rolesService = new RolesService(config, roles, accounts);
  const partnerPromos: PartnerPromos = { ofPartner: async (partnerId) => (await promo.list(500)).filter((row) => row.partnerId === partnerId) };
  const cabinet = new PartnerCabinet(rolesService, linked, partners, config, links, promo, partnerPromos, settings);
  return { accounts, roles, promo, partners, linked, links, settings, cabinet };
}
type Ctx = ReturnType<typeof setup>;

async function person(ctx: Ctx, id: string, role?: "admin" | "marketer" | "partner"): Promise<AccountRef> {
  const account = await ctx.accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Игрок ${id}`, username: null, photoUrl: null }, Date.now());
  if (role !== undefined) await ctx.roles.grant(account.accountId, role, null);
  return { accountId: account.accountId, platform: "telegram", platformUserId: id };
}

/** Партнёр с открытым кабинетом: карточка, аккаунт с ролью `partner` и связь между ними. */
async function partnerWithCabinet(ctx: Ctx, telegramId: string, name = `Канал ${telegramId}`) {
  const partnerId = randomUUID();
  await ctx.partners.create({ partnerId, name, contact: "@secret_contact", note: "тайная заметка", createdBy: randomUUID(), createdAt: NOW, updatedAt: NOW, telegramId, status: "active" });
  ctx.links.partners.set(partnerId, name);
  const actor = await person(ctx, telegramId, "partner");
  await ctx.linked.link(partnerId, actor.accountId);
  return { partnerId, actor };
}

/** Кампания партнёра: общий код с наградой; `createdBy` — кто завёл. */
async function campaign(ctx: Ctx, partnerId: string | null, display: string, patch: Partial<NewPromoCampaign> = {}) {
  const row: NewPromoCampaign = {
    campaignId: randomUUID(),
    title: "Код канала",
    kind: "shared",
    reward: { coins: 500, gems: 5, shard_common: 0, shard_uncommon: 0 },
    message: "Спасибо, что с нами",
    maxRedemptions: 300,
    startsAt: new Date(NOW.getTime() - HOUR),
    endsAt: new Date(NOW.getTime() + 10 * DAY),
    newPlayersDays: 14,
    platforms: ["telegram"],
    note: null,
    partnerId,
    createdBy: randomUUID(),
    createdAt: NOW,
    ...patch,
  };
  const outcome = await ctx.promo.create(row, [{ code: codeKey(display), display }], null);
  if (outcome.status !== "created") throw new Error("код занят");
  return outcome.row;
}

describe("название кампании ссылки", () => {
  it("кириллица — латиницей, всё лишнее — дефисом; пустое после очистки не годится", () => {
    expect(campaignSlug("Мой канал")).toBe("moy-kanal");
    expect(campaignSlug("  Стрим №3: «Рубеж»!  ")).toBe("strim-3-rubezh");
    expect(campaignSlug("Summer_2026")).toBe("summer_2026");
    expect(campaignSlug("Щи, ёж и юла")).toBe("schi-ezh-i-yula");
    expect(campaignSlug("a".repeat(100))).toHaveLength(64);
    expect(campaignSlug("!!!")).toBeNull();
    expect(campaignSlug("   ")).toBeNull();
  });
});

describe("ссылки кабинета партнёра (T-0218, Р136)", () => {
  it("партнёр заводит ссылку: владелец — он, цель Mini App, сети нет, источник и заметка записаны, в журнале — он как исполнитель", async () => {
    const ctx = setup();
    const { partnerId, actor } = await partnerWithCabinet(ctx, "900401");

    const created = await ctx.cabinet.createLink(actor, {}, { campaign: "Мой канал", source: "channel", note: "Игровой угол" });

    const stored = ctx.links.links.get(created.code);
    expect(stored).toMatchObject({ campaign: "moy-kanal", source: "channel", medium: null, note: "Игровой угол", target: "app", network: null, registrationOn: "first_run", platform: "telegram", createdBy: actor.accountId });
    expect(stored?.partner?.partnerId).toBe(partnerId);
    expect(created.url).toBe(`https://rubezh.example/r/${created.code}`);
    expect(ctx.roles.entries.filter((entry) => entry.action === "links.create")).toMatchObject([{ actorAccountId: actor.accountId, target: created.code, after: { campaign: "moy-kanal", source: "channel", partnerId } }]);
  });

  it("список: свои ссылки с переходами и запусками, без чужих и командных; в ответе нет игроков, контактов и заметок команды", async () => {
    const ctx = setup();
    const mine = await partnerWithCabinet(ctx, "900402");
    const other = await partnerWithCabinet(ctx, "900403");
    const own = await ctx.cabinet.createLink(mine.actor, {}, { campaign: "Пост", source: "post", note: null });
    await ctx.cabinet.createLink(other.actor, {}, { campaign: "Чужая", source: "chat", note: null });
    await ctx.links.create({ code: "teamcode0000001", platform: "telegram", campaign: "launch", source: "tg", medium: null, note: "командная", createdBy: null, network: null, registrationOn: "first_run", partnerId: null });
    ctx.links.clicks.set(own.code, 7);

    const list = await ctx.cabinet.links(mine.actor, {});

    expect(list.viewOnly).toBe(false);
    expect(list.limit).toEqual({ used: 1, max: 20 });
    expect(list.links).toEqual([{ code: own.code, url: `https://rubezh.example/r/${own.code}`, campaign: "post", source: "post", note: null, createdAt: NOW, clicks: 7, launches: 3 }]);
    const text = JSON.stringify(list);
    expect(text).not.toMatch(/Чужая|chat|командная|secret_contact|тайная/);
  });

  it("лимит: двадцать ссылок есть — отказ с числом из настроек; поднять лимит в настройках — можно дальше; ссылка команды партнёру тоже считается", async () => {
    const ctx = setup();
    const { partnerId, actor } = await partnerWithCabinet(ctx, "900404");
    for (let index = 0; index < 20; index += 1) await ctx.cabinet.createLink(actor, {}, { campaign: `kanal-${String(index)}`, source: "channel", note: null });

    await expect(ctx.cabinet.createLink(actor, {}, { campaign: "лишняя", source: "post", note: null })).rejects.toThrowError("Ссылок уже 20 — это потолок кабинета");
    expect(await codeOf(ctx.cabinet.createLink(actor, {}, { campaign: "лишняя", source: "post", note: null }))).toBe("validation_failed");
    expect(ctx.links.links.size).toBe(20);

    ctx.settings.set(SETTINGS.partnersCabinetMaxLinks.key, 21);
    await ctx.cabinet.createLink(actor, {}, { campaign: "двадцать первая", source: "post", note: null });
    await expect(ctx.cabinet.createLink(actor, {}, { campaign: "ещё", source: "post", note: null })).rejects.toThrowError("Ссылок уже 21 — это потолок кабинета");

    // Ссылка, заведённая командой от имени партнёра, лежит у него в кабинете и считается тоже.
    ctx.settings.set(SETTINGS.partnersCabinetMaxLinks.key, 22);
    await ctx.links.create({ code: "teamforpartner01", platform: "telegram", campaign: "team", source: null, medium: null, note: null, createdBy: null, network: null, registrationOn: "first_run", partnerId });
    await expect(ctx.cabinet.createLink(actor, {}, { campaign: "ещё", source: "post", note: null })).rejects.toThrowError("Ссылок уже 22 — это потолок кабинета");
  });

  it("плохой ввод: название без букв и цифр, длинная заметка, незнакомый источник — отказ до записи", async () => {
    const ctx = setup();
    const { actor } = await partnerWithCabinet(ctx, "900405");

    expect(await codeOf(ctx.cabinet.createLink(actor, {}, { campaign: "!!!", source: "post", note: null }))).toBe("validation_failed");
    expect(await codeOf(ctx.cabinet.createLink(actor, {}, { campaign: "ok", source: "post", note: "я".repeat(121) }))).toBe("validation_failed");
    expect(await codeOf(ctx.cabinet.createLink(actor, {}, { campaign: "ok", source: "podcast" as "post", note: null }))).toBe("validation_failed");
    expect(ctx.links.links.size).toBe(0);
  });

  it("глазами партнёра: владелец видит список, создать не может — «Кабинет открыт для просмотра»; партнёр чужой кабинет не открывает", async () => {
    const ctx = setup();
    const { partnerId, actor } = await partnerWithCabinet(ctx, "900406");
    const stranger = await partnerWithCabinet(ctx, "900407");
    const own = await ctx.cabinet.createLink(actor, {}, { campaign: "Канал", source: "channel", note: null });
    const admin = await person(ctx, "800", "admin");

    const seen = await ctx.cabinet.links(admin, { partnerId });
    expect(seen.viewOnly).toBe(true);
    expect(seen.links.map((link) => link.code)).toEqual([own.code]);
    await expect(ctx.cabinet.createLink(admin, { partnerId }, { campaign: "от админа", source: "post", note: null })).rejects.toThrowError("Кабинет открыт для просмотра");
    expect(await codeOf(ctx.cabinet.createLink(admin, { partnerId }, { campaign: "от админа", source: "post", note: null }))).toBe("forbidden");
    expect(ctx.links.links.size).toBe(1);

    expect(await codeOf(ctx.cabinet.links(stranger.actor, { partnerId }))).toBe("forbidden");
    expect(await codeOf(ctx.cabinet.createLink(stranger.actor, { partnerId }, { campaign: "в чужой", source: "post", note: null }))).toBe("forbidden");
    // Маркетолог без partners.view и без роли partner: ни своего, ни чужого.
    const marketer = await person(ctx, "801", "marketer");
    expect(await codeOf(ctx.cabinet.links(marketer, {}))).toBe("forbidden");
    expect(ctx.links.links.size).toBe(1);
  });

  it("аккаунт с ролью, но без карточки партнёра, и аккаунт без роли — отказ", async () => {
    const ctx = setup();
    const orphan = await person(ctx, "900408", "partner");
    const plain = await person(ctx, "900409");

    expect(await codeOf(ctx.cabinet.links(orphan, {}))).toBe("forbidden");
    expect(await codeOf(ctx.cabinet.createLink(orphan, {}, { campaign: "x1", source: "post", note: null }))).toBe("forbidden");
    expect(await codeOf(ctx.cabinet.links(plain, {}))).toBe("forbidden");
  });
});

describe("промокоды кабинета партнёра (T-0218, Р136)", () => {
  it("список: только кампании партнёра — код, награда, погашено из лимита, срок; чужие и командные не видны", async () => {
    const ctx = setup();
    const mine = await partnerWithCabinet(ctx, "900410");
    const other = await partnerWithCabinet(ctx, "900411");
    const own = await campaign(ctx, mine.partnerId, "KANAL 2026");
    await campaign(ctx, other.partnerId, "CHUZHOI");
    await campaign(ctx, null, "KOMANDA");

    const list = await ctx.cabinet.promos(mine.actor, {}, NOW);

    expect(list.viewOnly).toBe(false);
    expect(list.copies).toEqual({ used: 0, max: 5 });
    expect(list.promos).toEqual([
      {
        campaignId: own.campaignId,
        kind: "shared",
        code: "KANAL 2026",
        reward: { coins: 500, gems: 5, shard_common: 0, shard_uncommon: 0 },
        redeemed: 0,
        maxRedemptions: 300,
        startsAt: own.startsAt,
        endsAt: own.endsAt,
        state: "active",
        copy: false,
      },
    ]);
    expect(JSON.stringify(list)).not.toMatch(/CHUZHOI|KOMANDA|Код канала|Спасибо/);
  });

  it("копия: тот же reward, лимит, срок, площадки и окно новичков, новое слово, partner_id — он; создана партнёром, в журнале — promo.create", async () => {
    const ctx = setup();
    const { partnerId, actor } = await partnerWithCabinet(ctx, "900412");
    const source = await campaign(ctx, partnerId, "KANAL 2026");

    const copy = await ctx.cabinet.copyPromo(actor, {}, source.campaignId, "Stream 12 oct", NOW);

    expect(copy.code).toBe("STREAM 12 OCT");
    expect(copy.campaignId).not.toBe(source.campaignId);
    const stored = ctx.promo.campaigns.get(copy.campaignId);
    expect(stored).toMatchObject({
      kind: "shared",
      reward: source.reward,
      maxRedemptions: source.maxRedemptions,
      startsAt: source.startsAt,
      endsAt: source.endsAt,
      newPlayersDays: source.newPlayersDays,
      platforms: source.platforms,
      message: source.message,
      partnerId,
      createdBy: actor.accountId,
      redeemed: 0,
      pausedAt: null,
    });
    expect(ctx.promo.codeRows.get(codeKey("STREAM 12 OCT"))?.campaignId).toBe(copy.campaignId);
    expect(ctx.roles.entries.filter((entry) => entry.action === "promo.create")).toMatchObject([{ actorAccountId: actor.accountId, target: copy.campaignId }]);

    const list = await ctx.cabinet.promos(actor, {}, NOW);
    expect(list.copies).toEqual({ used: 1, max: 5 });
    expect(list.promos.map((promo) => [promo.code, promo.copy])).toEqual(
      expect.arrayContaining([
        ["KANAL 2026", false],
        ["STREAM 12 OCT", true],
      ]),
    );
  });

  it("отказы копии: пачка, чужая кампания, кампания команды, несуществующая, кончившаяся по сроку — без записи; про чужую — тот же ответ, что про несуществующую", async () => {
    const ctx = setup();
    const { partnerId, actor } = await partnerWithCabinet(ctx, "900413");
    const other = await partnerWithCabinet(ctx, "900414");
    const foreign = await campaign(ctx, other.partnerId, "CHUZHOI");
    const team = await campaign(ctx, null, "KOMANDA");
    const expired = await campaign(ctx, partnerId, "STARYI", { startsAt: new Date(NOW.getTime() - 10 * DAY), endsAt: new Date(NOW.getTime() - DAY) });
    const batchId = randomUUID();
    const batch = await ctx.promo.create(
      {
        campaignId: batchId,
        title: "Пачка",
        kind: "batch",
        reward: { coins: 100, gems: 0, shard_common: 0, shard_uncommon: 0 },
        message: null,
        maxRedemptions: 2,
        startsAt: new Date(NOW.getTime() - HOUR),
        endsAt: null,
        newPlayersDays: null,
        platforms: [],
        note: null,
        partnerId,
        createdBy: randomUUID(),
        createdAt: NOW,
      },
      [
        { code: "BATCHONE", display: "BATCH-ONE" },
        { code: "BATCHTWO", display: "BATCH-TWO" },
      ],
      null,
    );
    expect(batch.status).toBe("created");
    const before = ctx.promo.campaigns.size;

    await expect(ctx.cabinet.copyPromo(actor, {}, batchId, "Novoe slovo", NOW)).rejects.toThrowError("Пачку одноразовых кодов копировать нельзя");
    expect(await codeOf(ctx.cabinet.copyPromo(actor, {}, batchId, "Novoe slovo", NOW))).toBe("validation_failed");
    expect(await codeOf(ctx.cabinet.copyPromo(actor, {}, foreign.campaignId, "Novoe slovo", NOW))).toBe("promo_campaign_not_found");
    expect(await codeOf(ctx.cabinet.copyPromo(actor, {}, team.campaignId, "Novoe slovo", NOW))).toBe("promo_campaign_not_found");
    expect(await codeOf(ctx.cabinet.copyPromo(actor, {}, randomUUID(), "Novoe slovo", NOW))).toBe("promo_campaign_not_found");
    await expect(ctx.cabinet.copyPromo(actor, {}, expired.campaignId, "Novoe slovo", NOW)).rejects.toThrowError("Срок промокода уже закончился — копию не сделать");
    expect(ctx.promo.campaigns.size).toBe(before);
  });

  it("слово копии: короткое и с лишними знаками — отказ; занятое — без названия чужой кампании в тексте", async () => {
    const ctx = setup();
    const { partnerId, actor } = await partnerWithCabinet(ctx, "900415");
    const source = await campaign(ctx, partnerId, "KANAL 2026");
    await campaign(ctx, null, "KOMANDA", { title: "Секретная акция команды" });

    expect(await codeOf(ctx.cabinet.copyPromo(actor, {}, source.campaignId, "abc", NOW))).toBe("validation_failed");
    expect(await codeOf(ctx.cabinet.copyPromo(actor, {}, source.campaignId, "слово!?", NOW))).toBe("validation_failed");
    expect(await codeOf(ctx.cabinet.copyPromo(actor, {}, source.campaignId, "KANAL-2026", NOW))).toBe("promo_code_taken");
    let message = "";
    try {
      await ctx.cabinet.copyPromo(actor, {}, source.campaignId, "koman da", NOW);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toBe("Код KOMAN DA уже занят: нужно другое слово");
    expect(message).not.toMatch(/Секретная/);
  });

  it("лимит копий: пять есть — отказ с числом из настроек; поднять лимит — можно; копии, сделанные командой, не считаются", async () => {
    const ctx = setup();
    const { partnerId, actor } = await partnerWithCabinet(ctx, "900416");
    const source = await campaign(ctx, partnerId, "KANAL 2026");
    // Кампания партнёра, заведённая командой, — не копия партнёра.
    await campaign(ctx, partnerId, "OT KOMANDY");
    for (let index = 0; index < 5; index += 1) await ctx.cabinet.copyPromo(actor, {}, source.campaignId, `Kopiya ${String(index)} rubezh`, NOW);

    await expect(ctx.cabinet.copyPromo(actor, {}, source.campaignId, "Shestaya kopiya", NOW)).rejects.toThrowError("Копий уже 5 — это потолок кабинета");
    expect((await ctx.cabinet.promos(actor, {}, NOW)).copies).toEqual({ used: 5, max: 5 });

    ctx.settings.set(SETTINGS.partnersCabinetMaxPromoCopies.key, 6);
    await ctx.cabinet.copyPromo(actor, {}, source.campaignId, "Shestaya kopiya", NOW);
    await expect(ctx.cabinet.copyPromo(actor, {}, source.campaignId, "Sedmaya kopiya", NOW)).rejects.toThrowError("Копий уже 6 — это потолок кабинета");
  });

  it("копию можно сделать с копии: награда и лимит те же — награду партнёр не задаёт, у копии для неё нет входа", async () => {
    const ctx = setup();
    const { partnerId, actor } = await partnerWithCabinet(ctx, "900417");
    const source = await campaign(ctx, partnerId, "KANAL 2026");
    const first = await ctx.cabinet.copyPromo(actor, {}, source.campaignId, "Pervaya kopiya", NOW);

    const second = await ctx.cabinet.copyPromo(actor, {}, first.campaignId, "Vtoraya kopiya", NOW);

    expect(ctx.promo.campaigns.get(second.campaignId)).toMatchObject({ reward: source.reward, maxRedemptions: source.maxRedemptions, partnerId });
  });

  it("глазами партнёра: владелец видит список и счётчик копий партнёра, копию сделать не может; партнёр чужое не открывает", async () => {
    const ctx = setup();
    const { partnerId, actor } = await partnerWithCabinet(ctx, "900418");
    const other = await partnerWithCabinet(ctx, "900419");
    const source = await campaign(ctx, partnerId, "KANAL 2026");
    await ctx.cabinet.copyPromo(actor, {}, source.campaignId, "Kopiya rubezh", NOW);
    const admin = await person(ctx, "802", "admin");

    const seen = await ctx.cabinet.promos(admin, { partnerId }, NOW);
    expect(seen.viewOnly).toBe(true);
    expect(seen.copies).toEqual({ used: 1, max: 5 });
    expect(seen.promos).toHaveLength(2);
    await expect(ctx.cabinet.copyPromo(admin, { partnerId }, source.campaignId, "Ot admina", NOW)).rejects.toThrowError("Кабинет открыт для просмотра");
    expect(ctx.promo.campaigns.size).toBe(2);

    expect(await codeOf(ctx.cabinet.promos(other.actor, { partnerId }, NOW))).toBe("forbidden");
    // Чужую кампанию партнёр не копирует, даже зная её id.
    expect(await codeOf(ctx.cabinet.copyPromo(other.actor, {}, source.campaignId, "Ukrast kod", NOW))).toBe("promo_campaign_not_found");
  });
});

describe("кабинет партнёра по HTTP панели (T-0218)", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("партнёр заводит ссылку и копию кода по HTTP; мусорные тела и лишние поля — 400, чужие кампании — 404, глазами партнёра — 403", async () => {
    const config = loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV, AUTH_DEV_LOGIN: "true", ADMIN_TELEGRAM_IDS: OWNER_ID, PUBLIC_WEB_URL: "https://rubezh.example" } as NodeJS.ProcessEnv);
    const ctx = setup();
    const rolesService = new RolesService(config, ctx.roles, ctx.accounts);
    const promos: PartnerPromos = { ofPartner: async (partnerId) => (await ctx.promo.list(500)).filter((row) => row.partnerId === partnerId) };
    const cabinet = new PartnerCabinet(rolesService, ctx.linked, ctx.partners, config, ctx.links, ctx.promo, promos, ctx.settings);
    @Module({
      controllers: [AdminSessionController, AdminCabinetController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: ACCOUNT_REPOSITORY, useValue: ctx.accounts },
        { provide: ROLES_REPOSITORY, useValue: ctx.roles },
        { provide: ADMIN_SESSION_STORE, useValue: new MemoryAdminSessionStore() },
        { provide: PANEL_LOGIN_STORE, useValue: new MemoryPanelLoginStore() },
        { provide: AppLinks, useValue: new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]) },
        { provide: PartnerCabinet, useValue: cabinet },
        PanelLoginService,
        RateLimiter,
        RolesService,
        PermissionGuard,
        AuthGuard,
        AdminSessionService,
        AdminSessionGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const http = app;

    const cookieOf = async (devUser: string) => {
      const login = await http.inject({ method: "POST", url: "/api/v1/admin/session/dev", payload: { devUser } });
      return `${ADMIN_SESSION_COOKIE}=${/rubezh_admin_session=([^;]+)/.exec(String(login.headers["set-cookie"]))?.[1] ?? ""}`;
    };
    const base = "/api/v1/admin/cabinet";

    // Партнёр — аккаунт разработческого входа, связанный с карточкой.
    const partnerId = randomUUID();
    await ctx.partners.create({ partnerId, name: "Канал", contact: "@secret_contact", note: "тайная заметка", createdBy: randomUUID(), createdAt: NOW, updatedAt: NOW });
    ctx.links.partners.set(partnerId, "Канал");
    const dev = await ctx.accounts.upsert({ platform: "telegram", platformUserId: "dev-player-p1", displayName: "Партнёр", username: null, photoUrl: null }, Date.now());
    await ctx.roles.grant(dev.accountId, "partner", null);
    await ctx.linked.link(partnerId, dev.accountId);
    // Копия берёт «сейчас» с часов сервера, поэтому срок исходной кампании — от настоящего времени.
    const source = await campaign(ctx, partnerId, "KANAL 2026", { startsAt: new Date(Date.now() - HOUR), endsAt: new Date(Date.now() + 10 * DAY) });
    const foreign = await campaign(ctx, null, "KOMANDA");
    const partner = { cookie: await cookieOf("dev-player-p1:Партнёр"), [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE };
    const owner = { cookie: await cookieOf(`dev-${OWNER_ID}:Владелец`), [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE };

    expect((await http.inject({ method: "GET", url: `${base}/links` })).statusCode).toBe(401);
    expect((await http.inject({ method: "POST", url: `${base}/links`, headers: { cookie: partner.cookie }, payload: { campaign: "Пост", source: "post" } })).statusCode).toBe(403);

    const created = await http.inject({ method: "POST", url: `${base}/links`, headers: partner, payload: { campaign: "Мой пост", source: "post", note: "в канале" } });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ data: unknown }>().data).toMatchObject({ campaign: "moy-post", source: "post", note: "в канале", clicks: 0 });
    for (const bad of [{}, { campaign: "x", source: "post" }, { campaign: "Пост", source: "podcast" }, { campaign: "Пост", source: "post", target: "bot" }, { campaign: "Пост", source: "post", partnerId }, { campaign: "Пост", source: "post", note: "я".repeat(121) }]) {
      expect((await http.inject({ method: "POST", url: `${base}/links`, headers: partner, payload: bad })).statusCode, JSON.stringify(bad)).toBe(400);
    }
    const listed = await http.inject({ method: "GET", url: `${base}/links`, headers: partner });
    expect(listed.json<{ data: unknown }>().data).toMatchObject({ links: [{ campaign: "moy-post" }], limit: { used: 1, max: 20 }, viewOnly: false });

    const promoList = await http.inject({ method: "GET", url: `${base}/promos`, headers: partner });
    expect(promoList.json<{ data: { promos: { campaignId: string }[] } }>().data.promos.map((promo) => promo.campaignId)).toEqual([source.campaignId]);
    const copyUrl = (campaignId: string, query = "") => `${base}/promos/${campaignId}/copy${query}`;
    for (const bad of [{}, { code: "" }, { code: "X".repeat(49) }, { code: "NOVOE SLOVO", reward: { coins: 99999 } }, { code: "NOVOE SLOVO", maxRedemptions: 1_000_000 }]) {
      expect((await http.inject({ method: "POST", url: copyUrl(source.campaignId), headers: partner, payload: bad })).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await http.inject({ method: "POST", url: copyUrl("не-uuid"), headers: partner, payload: { code: "NOVOE SLOVO" } })).statusCode).toBe(400);
    expect((await http.inject({ method: "POST", url: copyUrl(foreign.campaignId), headers: partner, payload: { code: "NOVOE SLOVO" } })).statusCode).toBe(404);
    const copied = await http.inject({ method: "POST", url: copyUrl(source.campaignId), headers: partner, payload: { code: "novoe slovo" } });
    expect(copied.statusCode).toBe(201);
    expect(copied.json<{ data: unknown }>().data).toMatchObject({ code: "NOVOE SLOVO", copy: true, reward: source.reward });
    expect((await http.inject({ method: "POST", url: copyUrl(source.campaignId), headers: partner, payload: { code: "NOVOE-SLOVO" } })).statusCode).toBe(409);

    // Партнёр чужой кабинет не открывает даже запросом; владелец смотрит, но не пишет.
    expect((await http.inject({ method: "GET", url: `${base}/links?partnerId=${randomUUID()}`, headers: partner })).statusCode).toBe(403);
    expect((await http.inject({ method: "GET", url: `${base}/links?partnerId=${partnerId}&extra=1`, headers: owner })).statusCode).toBe(400);
    const watched = await http.inject({ method: "GET", url: `${base}/links?partnerId=${partnerId}`, headers: owner });
    expect(watched.statusCode).toBe(200);
    expect(watched.json<{ data: { viewOnly: boolean } }>().data.viewOnly).toBe(true);
    expect(watched.body).not.toMatch(/secret_contact|тайная/);
    const blocked = await http.inject({ method: "POST", url: `${base}/links?partnerId=${partnerId}`, headers: owner, payload: { campaign: "От админа", source: "post" } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.body).toContain("Кабинет открыт для просмотра");
    expect((await http.inject({ method: "POST", url: copyUrl(source.campaignId, `?partnerId=${partnerId}`), headers: owner, payload: { code: "OT ADMINA" } })).statusCode).toBe(403);
    expect(ctx.links.links.size).toBe(1);
  });
});
