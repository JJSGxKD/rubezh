import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "../src/common/domain-error.js";
import { loadAppConfig } from "../src/config/app-config.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaMediaRepository } from "../src/modules/media/media.repository.js";
import { MediaService } from "../src/modules/media/media.service.js";
import { PartnerCabinet, PrismaPartnerAccounts } from "../src/modules/partners/partner-cabinet.js";
import { PartnerMaterialsService, type MaterialInput } from "../src/modules/partners/partner-materials.js";
import { PrismaPartnerMaterialsRepository } from "../src/modules/partners/partner-materials.repository.js";
import { PrismaPartnersRepository } from "../src/modules/partners/partners.repository.js";
import { PrismaRolesRepository } from "../src/modules/roles/roles.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { uniquePlatformUserId } from "./helpers/player-ids.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Материалы для партнёров на живом Postgres (docs/17-testing-strategy.md §4.2; адрес — TEST_DATABASE_URL, без него
 * пропуск; tasks/T-0221): выборка кабинета отдаёт общие и свои материалы без архивных, режим «глазами партнёра» не
 * смешивает партнёров, загрузка баннера требует `partners.edit`, а база держит форму строки в обход сервиса.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const NOW = new Date();

/** Заголовок WebP без потерь нужных сторон: проверка профиля читает только его; соль делает файл уникальным. */
function webpOf(width: number, height: number, salt: number): Buffer {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const body = Buffer.from([0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff, ...new Array<number>(15).fill(0), salt & 0xff]);
  const header = Buffer.alloc(20);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(12 + body.length, 4);
  header.write("WEBP", 8, "latin1");
  header.write("VP8L", 12, "latin1");
  header.writeUInt32LE(body.length, 16);
  return Buffer.concat([header, body]);
}

describe.skipIf(DATABASE_URL === "")("материалы для партнёров на живом Postgres (T-0221)", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let partners: PrismaPartnersRepository;
  let linked: PrismaPartnerAccounts;
  let materials: PrismaPartnerMaterialsRepository;
  let service: PartnerMaterialsService;
  let cabinet: PartnerCabinet;
  let media: MediaService;
  const staff: string[] = [];
  const created: string[] = [];

  async function player(): Promise<AccountRef> {
    const telegramId = uniquePlatformUserId();
    const account = await accounts.upsert({ platform: "telegram", platformUserId: telegramId, displayName: "Игрок", username: null, photoUrl: null }, NOW.getTime());
    return { accountId: account.accountId, platform: "telegram", platformUserId: telegramId };
  }

  async function withRole(role: "partner" | "marketer" | "moderator"): Promise<AccountRef> {
    const who = await player();
    await prisma.accountRole.create({ data: { accountId: who.accountId, role } });
    staff.push(who.accountId);
    return who;
  }

  async function partnerWithCabinet(name: string) {
    const partnerId = randomUUID();
    await partners.create({ partnerId, name, contact: "@channel", note: "тайная заметка", createdBy: randomUUID(), createdAt: NOW, updatedAt: NOW });
    const actor = await withRole("partner");
    await linked.link(partnerId, actor.accountId, NOW);
    return { partnerId, actor };
  }

  async function addPost(actor: AccountRef, title: string, patch: Partial<MaterialInput> = {}) {
    const row = await service.create(actor, { kind: "post", title, text: `Текст «${title}»`, imageId: null, partnerId: null, sort: 0, ...patch }, NOW);
    created.push(row.materialId);
    return row;
  }

  beforeAll(() => {
    prisma = testPrisma(DATABASE_URL, 8);
    accounts = new PrismaAccountRepository(prisma);
    partners = new PrismaPartnersRepository(prisma);
    linked = new PrismaPartnerAccounts(prisma);
    materials = new PrismaPartnerMaterialsRepository(prisma);
    const config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL, PUBLIC_WEB_URL: "https://rubezh.example" } as NodeJS.ProcessEnv);
    const roles = new RolesService(config, new PrismaRolesRepository(prisma), accounts);
    media = new MediaService(new PrismaMediaRepository(prisma), roles);
    service = new PartnerMaterialsService(materials, roles, partners, media);
    cabinet = new PartnerCabinet(roles, linked, partners, config, null, null, null, null, null, materials);
  });

  afterAll(async () => {
    await prisma.partnerMaterial.deleteMany({ where: { materialId: { in: created } } });
    await prisma.accountRole.deleteMany({ where: { accountId: { in: staff } } });
    await prisma.$disconnect();
  });

  it("партнёр видит общие и свои, не видит чужие и архивные; порядок — по `sort`", async () => {
    const team = await withRole("marketer");
    const mine = await partnerWithCabinet("Свой канал");
    const other = await partnerWithCabinet("Чужой канал");
    const shared = await addPost(team, "Общий", { sort: 20 });
    const own = await addPost(team, "Свой", { partnerId: mine.partnerId, sort: 10 });
    const foreign = await addPost(team, "Чужой", { partnerId: other.partnerId, sort: 1 });
    const gone = await addPost(team, "Общий в архиве", { sort: 0 });
    await service.setArchived(team, gone.materialId, true, NOW);
    const goneOwn = await addPost(team, "Свой в архиве", { partnerId: mine.partnerId, sort: 0 });
    await service.setArchived(team, goneOwn.materialId, true, NOW);

    const seen = (await cabinet.materials(mine.actor, {})).materials.map((item) => item.materialId);

    // общих материалов в базе от других прогонов может быть сколько угодно: сверяется только то, что завели здесь
    const ours = [shared, own, foreign, gone, goneOwn].map((row) => row.materialId);
    expect(seen.filter((id) => ours.includes(id))).toEqual([own.materialId, shared.materialId]);
  });

  it("режим «глазами партнёра» не отдаёт материалы другого партнёра; партнёр чужой кабинет не откроет", async () => {
    const team = await withRole("marketer");
    const first = await partnerWithCabinet("Первый");
    const second = await partnerWithCabinet("Второй");
    const forFirst = await addPost(team, "Только первому", { partnerId: first.partnerId });
    const forSecond = await addPost(team, "Только второму", { partnerId: second.partnerId });

    const firstView = await cabinet.materials(team, { partnerId: first.partnerId });
    const secondView = await cabinet.materials(team, { partnerId: second.partnerId });

    expect(firstView.viewOnly).toBe(true);
    expect(firstView.materials.map((item) => item.materialId)).toContain(forFirst.materialId);
    expect(firstView.materials.map((item) => item.materialId)).not.toContain(forSecond.materialId);
    expect(secondView.materials.map((item) => item.materialId)).toContain(forSecond.materialId);
    expect(secondView.materials.map((item) => item.materialId)).not.toContain(forFirst.materialId);
    await expect(cabinet.materials(first.actor, { partnerId: second.partnerId })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("баннер: картинка профиля partner_material сохраняется, размеры приходят в кабинет; без partners.edit загрузка — отказ", async () => {
    const team = await withRole("marketer");
    const outsider = await withRole("moderator");
    const mine = await partnerWithCabinet("Баннерный");
    const salt = Math.floor(Math.random() * 256);

    await expect(media.upload(outsider, "partner_material", webpOf(1080, 1080, salt))).rejects.toBeInstanceOf(ForbiddenError);
    const { imageId } = await media.upload(team, "partner_material", webpOf(1080, 1080, salt));
    const banner = await service.create(team, { kind: "banner", title: "Баннер 1080×1080", text: null, imageId, partnerId: mine.partnerId, sort: 0 }, NOW);
    created.push(banner.materialId);

    const seen = (await cabinet.materials(mine.actor, {})).materials.find((item) => item.materialId === banner.materialId);
    expect(seen).toMatchObject({ kind: "banner", imageId, imageWidth: 1080, imageHeight: 1080, shared: false });
  });

  it("база держит форму строки в обход сервиса: баннер без картинки, текст без текста и неизвестный вид не пишутся", async () => {
    const insert = async (patch: Record<string, unknown>) =>
      await prisma.partnerMaterial.create({ data: { materialId: randomUUID(), kind: "post", title: "Пост", text: "Текст", sort: 0, createdBy: randomUUID(), createdAt: NOW, updatedAt: NOW, ...patch } });
    await expect(insert({ kind: "banner", text: null, imageId: null })).rejects.toThrow();
    await expect(insert({ kind: "post", text: null })).rejects.toThrow();
    await expect(insert({ kind: "rules", text: "" })).rejects.toThrow();
    await expect(insert({ kind: "video" })).rejects.toThrow();
    await expect(insert({ title: "я".repeat(81) })).rejects.toThrow();
    await expect(insert({ text: "я".repeat(2001) })).rejects.toThrow();
    await expect(insert({ sort: -1 })).rejects.toThrow();
    const ok = await insert({});
    created.push(ok.materialId);
  });
});
