import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { loadAppConfig } from "../src/config/app-config.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { newClickId, newLinkCode } from "../src/modules/links/link-code.js";
import { PrismaLinksRepository } from "../src/modules/links/links.repository.js";
import { PartnerCabinet, PrismaPartnerAccounts, PrismaPartnerPromos } from "../src/modules/partners/partner-cabinet.js";
import { PrismaPartnersRepository } from "../src/modules/partners/partners.repository.js";
import { codeKey } from "../src/modules/promo-codes/promo-code-rules.js";
import { PrismaPromoCodesRepository, type NewPromoCampaign } from "../src/modules/promo-codes/promo-codes.repository.js";
import { PrismaRolesRepository } from "../src/modules/roles/roles.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { panelSettings } from "./helpers/settings.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Кабинет партнёра, ссылки и промокоды, на живом Postgres (docs/17-testing-strategy.md §4.2; адрес —
 * TEST_DATABASE_URL, без него пропуск; tasks/T-0218): владелец ссылки — партнёр кабинета, чужое и командное
 * в список не попадает, копия кампании сохраняет награду, лимит и срок, а её погашение привязывает игрока.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date();

describe.skipIf(DATABASE_URL === "")("кабинет партнёра: ссылки и промокоды на живом Postgres (T-0218)", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let partners: PrismaPartnersRepository;
  let promo: PrismaPromoCodesRepository;
  let links: PrismaLinksRepository;
  let linked: PrismaPartnerAccounts;
  let cabinet: PartnerCabinet;
  const staff: string[] = [];

  const freshTelegramId = () => String(Math.floor(Math.random() * 1e15) + 3e15);
  const uniqueWord = () => `K${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;

  async function player(): Promise<AccountRef> {
    const telegramId = freshTelegramId();
    const account = await accounts.upsert({ platform: "telegram", platformUserId: telegramId, displayName: "Игрок", username: null, photoUrl: null }, NOW.getTime());
    return { accountId: account.accountId, platform: "telegram", platformUserId: telegramId };
  }

  /** Партнёр с карточкой, связанным аккаунтом и ролью `partner`; роль убирается после прогона. */
  async function partnerWithCabinet(name: string) {
    const partnerId = randomUUID();
    await partners.create({ partnerId, name, contact: "@channel", note: "тайная заметка", createdBy: randomUUID(), createdAt: NOW, updatedAt: NOW });
    const actor = await player();
    await prisma.accountRole.create({ data: { accountId: actor.accountId, role: "partner" } });
    staff.push(actor.accountId);
    await linked.link(partnerId, actor.accountId, NOW);
    return { partnerId, actor };
  }

  async function ownerOf(): Promise<AccountRef> {
    const who = await player();
    await prisma.accountRole.create({ data: { accountId: who.accountId, role: "admin" } });
    staff.push(who.accountId);
    return who;
  }

  async function campaign(partnerId: string | null, display: string, patch: Partial<NewPromoCampaign> = {}) {
    const row: NewPromoCampaign = {
      campaignId: randomUUID(),
      title: "Код канала",
      kind: "shared",
      reward: { coins: 500, gems: 5, shard_common: 0, shard_uncommon: 0 },
      message: null,
      maxRedemptions: 300,
      startsAt: new Date(NOW.getTime() - HOUR),
      endsAt: new Date(NOW.getTime() + 10 * DAY),
      newPlayersDays: null,
      platforms: [],
      note: null,
      partnerId,
      createdBy: randomUUID(),
      createdAt: NOW,
      ...patch,
    };
    const outcome = await promo.create(row, [{ code: codeKey(display), display }], null);
    if (outcome.status !== "created") throw new Error("код занят");
    return outcome.row;
  }

  beforeAll(() => {
    prisma = testPrisma(DATABASE_URL, 8);
    accounts = new PrismaAccountRepository(prisma);
    partners = new PrismaPartnersRepository(prisma);
    promo = new PrismaPromoCodesRepository(prisma);
    links = new PrismaLinksRepository(prisma);
    linked = new PrismaPartnerAccounts(prisma);
    const config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL, PUBLIC_WEB_URL: "https://rubezh.example" } as NodeJS.ProcessEnv);
    const roles = new RolesService(config, new PrismaRolesRepository(prisma), accounts);
    cabinet = new PartnerCabinet(roles, linked, partners, config, links, promo, new PrismaPartnerPromos(prisma), panelSettings());
  });

  afterAll(async () => {
    await prisma.accountRole.deleteMany({ where: { accountId: { in: staff } } });
    await prisma.$disconnect();
  });

  it("партнёр заводит ссылку: partner_id — он, target — app, сети нет; в журнале аудита он сам", async () => {
    const { partnerId, actor } = await partnerWithCabinet("Заведу ссылку");

    const created = await cabinet.createLink(actor, {}, { campaign: "Мой канал", source: "stream", note: "Игровой угол" });

    const row = await prisma.link.findUnique({ where: { code: created.code } });
    expect(row).toMatchObject({ partnerId, target: "app", network: null, campaign: "moy-kanal", source: "stream", note: "Игровой угол", platform: "telegram", createdBy: actor.accountId, auto: false });
    const audit = await prisma.auditEntry.findMany({ where: { action: "links.create", target: created.code } });
    expect(audit).toMatchObject([{ actorAccountId: actor.accountId }]);
  });

  it("список ссылок не показывает ссылки другого партнёра и команды; клики и запуски считаются теми же запросами, что в разделе «Ссылки»", async () => {
    const mine = await partnerWithCabinet("Моя сторона");
    const other = await partnerWithCabinet("Чужая сторона");
    const own = await cabinet.createLink(mine.actor, {}, { campaign: "Пост", source: "post", note: null });
    const foreign = await cabinet.createLink(other.actor, {}, { campaign: "Чужая", source: "chat", note: null });
    const team = await links.create({ code: newLinkCode(), platform: "telegram", campaign: "launch", source: "tg", medium: null, note: null, createdBy: null, network: null, registrationOn: "first_run", partnerId: null });
    await links.recordClick({ clickId: newClickId(), linkCode: own.code, at: NOW, utm: { source: null, medium: null, campaign: null, content: null, term: null }, refererHost: null, deviceClass: "mobile", ipPrefix: null, language: null, networkParams: null });

    const list = await cabinet.links(mine.actor, {});

    expect(list.links.map((link) => link.code)).toEqual([own.code]);
    expect(list.links[0]).toMatchObject({ clicks: 1, launches: 0, source: "post" });
    expect(list.limit).toEqual({ used: 1, max: 20 });
    expect(JSON.stringify(list)).not.toContain(foreign.code);
    expect(JSON.stringify(list)).not.toContain(team.code);
  });

  it("копия своей кампании: тот же reward, лимит, срок и площадки, partner_id — он; погашение копии привязывает нового игрока к партнёру", async () => {
    const { partnerId, actor } = await partnerWithCabinet("Копирую код");
    const source = await campaign(partnerId, uniqueWord(), { platforms: ["telegram"], newPlayersDays: 30, message: "Привет от канала" });

    const copy = await cabinet.copyPromo(actor, {}, source.campaignId, uniqueWord(), NOW);

    const row = await promo.byId(copy.campaignId);
    expect(row).toMatchObject({
      kind: "shared",
      reward: source.reward,
      maxRedemptions: source.maxRedemptions,
      startsAt: source.startsAt,
      endsAt: source.endsAt,
      platforms: ["telegram"],
      newPlayersDays: 30,
      message: "Привет от канала",
      partnerId,
      createdBy: actor.accountId,
      redeemed: 0,
    });
    expect(copy.reward).toEqual(source.reward);

    const newbie = await player();
    expect(await promo.redeem({ campaignId: copy.campaignId, accountId: newbie.accountId, code: codeKey(copy.code), batch: false, partnerId, at: NOW })).toEqual({ status: "redeemed", bound: true });
    expect(await partners.bindingOf(newbie.accountId)).toMatchObject({ partnerId });
    expect(await prisma.auditEntry.findMany({ where: { action: "promo.create", target: copy.campaignId } })).toMatchObject([{ actorAccountId: actor.accountId }]);

    const list = await cabinet.promos(actor, {}, NOW);
    expect(list.copies).toEqual({ used: 1, max: 5 });
    expect(list.promos.find((promo_) => promo_.campaignId === copy.campaignId)).toMatchObject({ copy: true, redeemed: 1, code: copy.code });
  });

  it("чужая кампания и пачка не копируются; слово, занятое кампанией команды, отвечает без её названия", async () => {
    const { partnerId, actor } = await partnerWithCabinet("Пытаюсь украсть");
    const other = await partnerWithCabinet("Чей-то код");
    const foreign = await campaign(other.partnerId, uniqueWord());
    const taken = uniqueWord();
    await campaign(null, taken, { title: "Секретная акция команды" });
    const own = await campaign(partnerId, uniqueWord());

    await expect(cabinet.copyPromo(actor, {}, foreign.campaignId, uniqueWord(), NOW)).rejects.toMatchObject({ code: "promo_campaign_not_found" });
    await expect(cabinet.copyPromo(actor, {}, own.campaignId, taken, NOW)).rejects.toThrowError(`Код ${taken} уже занят: нужно другое слово`);
    expect(await prisma.promoCampaign.count({ where: { partnerId, createdBy: actor.accountId } })).toBe(0);

    const batchId = randomUUID();
    const pack = `PACK${uniqueWord()}`;
    await promo.create(
      {
        campaignId: batchId,
        title: "Пачка",
        kind: "batch",
        reward: { coins: 100, gems: 0, shard_common: 0, shard_uncommon: 0 },
        message: null,
        maxRedemptions: 1,
        startsAt: new Date(NOW.getTime() - HOUR),
        endsAt: null,
        newPlayersDays: null,
        platforms: [],
        note: null,
        partnerId,
        createdBy: randomUUID(),
        createdAt: NOW,
      },
      [{ code: codeKey(pack), display: pack }],
      null,
    );
    await expect(cabinet.copyPromo(actor, {}, batchId, uniqueWord(), NOW)).rejects.toThrowError("Пачку одноразовых кодов копировать нельзя");
  });

  it("владелец смотрит кабинет глазами партнёра: список виден, создание ссылки и копии — отказ, ничего не записано", async () => {
    const { partnerId, actor } = await partnerWithCabinet("Смотрят сверху");
    const admin = await ownerOf();
    const source = await campaign(partnerId, uniqueWord());
    const created = await cabinet.createLink(actor, {}, { campaign: "Канал", source: "channel", note: null });

    const seenLinks = await cabinet.links(admin, { partnerId });
    const seenPromos = await cabinet.promos(admin, { partnerId }, NOW);
    expect(seenLinks.viewOnly).toBe(true);
    expect(seenLinks.links.map((link) => link.code)).toEqual([created.code]);
    expect(seenPromos.viewOnly).toBe(true);
    expect(seenPromos.promos.map((item) => item.campaignId)).toEqual([source.campaignId]);

    await expect(cabinet.createLink(admin, { partnerId }, { campaign: "От админа", source: "post", note: null })).rejects.toThrowError("Кабинет открыт для просмотра");
    await expect(cabinet.copyPromo(admin, { partnerId }, source.campaignId, uniqueWord(), NOW)).rejects.toThrowError("Кабинет открыт для просмотра");
    expect(await prisma.link.count({ where: { partnerId } })).toBe(1);
    expect(await prisma.promoCampaign.count({ where: { partnerId } })).toBe(1);
  });
});
