import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DomainError, ForbiddenError } from "../src/common/domain-error.js";
import { loadAppConfig } from "../src/config/app-config.js";
import { IMAGE_PROFILES, checkImage, imageIdOf } from "../src/modules/media/image-rules.js";
import { ImageNotFoundError } from "../src/modules/media/media-errors.js";
import { MediaService } from "../src/modules/media/media.service.js";
import { PartnerCabinet } from "../src/modules/partners/partner-cabinet.js";
import { MATERIAL_LIMITS, PartnerMaterialsService, materialInputSchema, materialsVisibleTo, type MaterialInput, type MaterialRow } from "../src/modules/partners/partner-materials.js";
import type { MaterialPatch, NewMaterialRow, PartnerMaterialsRepository } from "../src/modules/partners/partner-materials.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryMedia } from "./helpers/memory-media.js";
import { MemoryPartnerAccounts } from "./helpers/memory-partner-accounts.js";
import { MemoryPartnersRepository } from "./helpers/memory-partners.js";
import { MemoryPromoCodesRepository } from "./helpers/memory-promo-codes.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Материалы для партнёров (docs/35-stage4-plan.md Р136, tasks/T-0221): команда выкладывает баннеры, тексты постов и
 * правила — для всех партнёров или одному; партнёр видит в кабинете только общие и свои, без архивных, и ничего
 * лишнего сверх самого материала.
 */

const NOW = new Date(Date.UTC(2026, 9, 24, 9));
const OWNER_ID = "777000555";

/** Картинка WebP без потерь нужных сторон: заголовок настоящий, содержимое — заполнитель. */
function webpOf(width: number, height: number): Buffer {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const body = Buffer.from([0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff, ...new Array<number>(16).fill(0)]);
  const header = Buffer.alloc(20);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(12 + body.length, 4);
  header.write("WEBP", 8, "latin1");
  header.write("VP8L", 12, "latin1");
  header.writeUInt32LE(body.length, 16);
  return Buffer.concat([header, body]);
}

/** Материалы в памяти: тот же смысл, что у запросов к базе, — выборка кабинета и архив. */
class MemoryMaterials implements PartnerMaterialsRepository {
  readonly rows = new Map<string, MaterialRow>();
  readonly partnerNames = new Map<string, string>();

  async list(limit: number): Promise<MaterialRow[]> {
    return [...this.rows.values()].sort(bySort).slice(0, limit);
  }

  async listFor(partnerId: string): Promise<MaterialRow[]> {
    return [...this.rows.values()].filter((row) => row.archivedAt === null && (row.partnerId === null || row.partnerId === partnerId)).sort(bySort);
  }

  async byId(materialId: string): Promise<MaterialRow | null> {
    return this.rows.get(materialId) ?? null;
  }

  async insert(row: NewMaterialRow): Promise<MaterialRow> {
    const stored: MaterialRow = { ...row, updatedAt: row.createdAt, archivedAt: null, partnerName: row.partnerId === null ? null : (this.partnerNames.get(row.partnerId) ?? null), imageWidth: null, imageHeight: null };
    this.rows.set(row.materialId, stored);
    return stored;
  }

  async update(materialId: string, patch: MaterialPatch, at: Date): Promise<{ before: MaterialRow; after: MaterialRow } | null> {
    const before = this.rows.get(materialId);
    if (before === undefined) return null;
    const after: MaterialRow = { ...before, ...patch, updatedAt: at, partnerName: patch.partnerId === null ? null : (this.partnerNames.get(patch.partnerId) ?? null) };
    this.rows.set(materialId, after);
    return { before, after };
  }

  async setArchived(materialId: string, archivedAt: Date | null, at: Date): Promise<{ before: MaterialRow; after: MaterialRow } | null> {
    const before = this.rows.get(materialId);
    if (before === undefined) return null;
    const after: MaterialRow = { ...before, archivedAt, updatedAt: at };
    this.rows.set(materialId, after);
    return { before, after };
  }
}

function bySort(a: MaterialRow, b: MaterialRow): number {
  return a.sort - b.sort || a.createdAt.getTime() - b.createdAt.getTime();
}

function setup() {
  const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
  const accounts = new MemoryAccountRepository();
  const roles = new MemoryRolesRepository();
  const rolesService = new RolesService(config, roles, accounts);
  const promo = new MemoryPromoCodesRepository();
  const partners = new MemoryPartnersRepository(promo);
  const linked = new MemoryPartnerAccounts(accounts, partners);
  const media = new MemoryMedia();
  const mediaService = new MediaService(media, rolesService);
  const materials = new MemoryMaterials();
  const service = new PartnerMaterialsService(materials, rolesService, partners, mediaService);
  const cabinet = new PartnerCabinet(rolesService, linked, partners, null, null, null, null, null, null, materials);
  return { accounts, roles, partners, linked, materials, mediaService, service, cabinet };
}
type Ctx = ReturnType<typeof setup>;

async function person(ctx: Ctx, id: string, role?: "admin" | "marketer" | "partner" | "moderator" | "finance"): Promise<AccountRef> {
  const account = await ctx.accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Игрок ${id}`, username: null, photoUrl: null }, Date.now());
  if (role !== undefined) await ctx.roles.grant(account.accountId, role, null);
  return { accountId: account.accountId, platform: "telegram", platformUserId: id };
}

async function partnerWithCabinet(ctx: Ctx, telegramId: string, name = `Канал ${telegramId}`) {
  const partnerId = randomUUID();
  await ctx.partners.create({ partnerId, name, contact: "@secret_contact", note: "тайная заметка", createdBy: randomUUID(), createdAt: NOW, updatedAt: NOW, telegramId, status: "active" });
  ctx.materials.partnerNames.set(partnerId, name);
  const actor = await person(ctx, telegramId, "partner");
  await ctx.linked.link(partnerId, actor.accountId);
  return { partnerId, actor };
}

/** Баннер: картинка проходит ту же проверку профиля, что при загрузке из панели. */
async function uploadBanner(ctx: Ctx, uploader: AccountRef, width = 1080, height = 1080): Promise<string> {
  return (await ctx.mediaService.upload(uploader, "partner_material", webpOf(width, height))).imageId;
}

const post = (patch: Partial<MaterialInput> = {}): MaterialInput => ({ kind: "post", title: "Текст для анонса", text: "Играйте в «Рубеж»", imageId: null, partnerId: null, sort: 0, ...patch });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return "ok";
}

describe("материал партнёра: схема", () => {
  const image = "a".repeat(64);
  const parse = (value: unknown) => materialInputSchema.safeParse(value);

  it("баннер без картинки — ошибка; с картинкой годится, подпись может быть пустой", () => {
    expect(parse({ kind: "banner", title: "Баннер 1080×1080", imageId: null }).success).toBe(false);
    expect(parse({ kind: "banner", title: "Баннер 1080×1080" }).success).toBe(false);
    const ok = parse({ kind: "banner", title: "Баннер 1080×1080", imageId: image });
    expect(ok.success).toBe(true);
    expect(ok.data).toMatchObject({ text: null, partnerId: null, sort: 0 });
    expect(parse({ kind: "banner", title: "Баннер", imageId: image, text: "  " }).data).toMatchObject({ text: null });
  });

  it("пост и правила без текста — ошибка, в том числе из одних пробелов", () => {
    for (const kind of ["post", "rules"] as const) {
      expect(parse({ kind, title: "Название" }).success, kind).toBe(false);
      expect(parse({ kind, title: "Название", text: "   " }).success, kind).toBe(false);
      expect(parse({ kind, title: "Название", text: "Текст" }).success, kind).toBe(true);
    }
  });

  it("текст ровно в 2000 знаков годится, 2001 — ошибка", () => {
    expect(parse({ kind: "post", title: "Пост", text: "я".repeat(MATERIAL_LIMITS.textMax) }).success).toBe(true);
    expect(parse({ kind: "post", title: "Пост", text: "я".repeat(MATERIAL_LIMITS.textMax + 1) }).success).toBe(false);
    expect(parse({ kind: "banner", title: "Баннер", imageId: image, text: "я".repeat(MATERIAL_LIMITS.textMax + 1) }).success).toBe(false);
  });

  it("название: от одного знака до восьмидесяти", () => {
    expect(parse({ kind: "post", title: "", text: "Текст" }).success).toBe(false);
    expect(parse({ kind: "post", title: "   ", text: "Текст" }).success).toBe(false);
    expect(parse({ kind: "post", title: "я".repeat(80), text: "Текст" }).success).toBe(true);
    expect(parse({ kind: "post", title: "я".repeat(81), text: "Текст" }).success).toBe(false);
  });

  it("у текстового материала картинки нет; id картинки — хэш; партнёр — uuid; вид — из списка; лишнее поле — ошибка", () => {
    expect(parse({ kind: "post", title: "Пост", text: "Текст", imageId: image }).success).toBe(false);
    expect(parse({ kind: "banner", title: "Баннер", imageId: "не хэш" }).success).toBe(false);
    expect(parse({ kind: "post", title: "Пост", text: "Текст", partnerId: "не uuid" }).success).toBe(false);
    expect(parse({ kind: "post", title: "Пост", text: "Текст", partnerId: randomUUID() }).success).toBe(true);
    expect(parse({ kind: "video", title: "Пост", text: "Текст" }).success).toBe(false);
    expect(parse({ kind: "post", title: "Пост", text: "Текст", archivedAt: "2026-01-01" }).success).toBe(false);
  });

  it("порядок — целое от 0 до 9999", () => {
    expect(parse({ kind: "post", title: "Пост", text: "Текст", sort: 9999 }).success).toBe(true);
    expect(parse({ kind: "post", title: "Пост", text: "Текст", sort: -1 }).success).toBe(false);
    expect(parse({ kind: "post", title: "Пост", text: "Текст", sort: 1.5 }).success).toBe(false);
  });
});

describe("профиль картинки partner_material", () => {
  const profile = IMAGE_PROFILES.partner_material;

  it("не квадрат, стороны от 200 до 2048, право — partners.edit", () => {
    expect(profile).toMatchObject({ square: false, minSide: 200, maxSide: 2048, permission: "partners.edit" });
    expect(checkImage(webpOf(1080, 1080), profile)).toEqual({ ok: true, width: 1080, height: 1080 });
    expect(checkImage(webpOf(1200, 628), profile)).toEqual({ ok: true, width: 1200, height: 628 });
    expect(checkImage(webpOf(200, 2048), profile)).toMatchObject({ ok: true });
  });

  it("мельче 200 и крупнее 2048 — отказ словами; картинка открыта игроку и панели без отдельного права", () => {
    expect(checkImage(webpOf(199, 600), profile)).toMatchObject({ ok: false, problem: expect.stringContaining("не меньше 200") });
    expect(checkImage(webpOf(2049, 600), profile)).toMatchObject({ ok: false, problem: expect.stringContaining("не больше 2048") });
    expect(profile).not.toHaveProperty("viewPermission");
  });

  it("загрузить может тот, у кого есть partners.edit; без него — отказ, строка не пишется", async () => {
    const ctx = setup();
    const moderator = await person(ctx, "910001", "moderator");
    const partner = (await partnerWithCabinet(ctx, "910002")).actor;
    const finance = await person(ctx, "910003", "finance");
    for (const who of [moderator, partner, finance]) await expect(ctx.mediaService.upload(who, "partner_material", webpOf(1080, 1080))).rejects.toBeInstanceOf(ForbiddenError);
    expect(ctx.materials.rows.size).toBe(0);
    const marketer = await person(ctx, "910004", "marketer");
    await expect(ctx.mediaService.upload(marketer, "partner_material", webpOf(1080, 1080))).resolves.toMatchObject({ width: 1080, height: 1080 });
  });
});

describe("материалы в панели команды", () => {
  it("баннер: картинка проверяется профилем, строка пишется с автором, в журнале — действие и поля", async () => {
    const ctx = setup();
    const marketer = await person(ctx, "910010", "marketer");
    const imageId = await uploadBanner(ctx, marketer);

    const created = await ctx.service.create(marketer, { kind: "banner", title: "Баннер для поста 1080×1080", text: null, imageId, partnerId: null, sort: 3 }, NOW);

    expect(created).toMatchObject({ kind: "banner", title: "Баннер для поста 1080×1080", imageId, partnerId: null, sort: 3, createdBy: marketer.accountId, archivedAt: null });
    expect(ctx.materials.rows.get(created.materialId)).toBeDefined();
    expect(ctx.roles.entries.filter((entry) => entry.action === "partner_material.create")).toMatchObject([{ actorAccountId: marketer.accountId, target: created.materialId, after: { kind: "banner", imageId, partnerId: null } }]);
  });

  it("баннер с несуществующей или не подходящей профилю картинкой — отказ без записи", async () => {
    const ctx = setup();
    const marketer = await person(ctx, "910011", "marketer");
    const banner = (imageId: string): MaterialInput => ({ kind: "banner", title: "Баннер", text: null, imageId, partnerId: null, sort: 0 });
    expect(await codeOf(ctx.service.create(marketer, banner("f".repeat(64)), NOW))).toBe(new ImageNotFoundError().code);
    // мелкая картинка задания (96 px) профилю баннера не годится: он начинается с 200 px
    const admin = await person(ctx, "910012", "admin");
    const { imageId } = await ctx.mediaService.upload(admin, "task", webpOf(96, 96));
    expect(await codeOf(ctx.service.create(marketer, banner(imageId), NOW))).toBe("image_rejected");
    expect(ctx.materials.rows.size).toBe(0);
  });

  it("для одного партнёра — только существующему; нет такого — 404, строка не пишется", async () => {
    const ctx = setup();
    const marketer = await person(ctx, "910013", "marketer");
    const { partnerId } = await partnerWithCabinet(ctx, "910014", "Игровой угол");

    expect(await codeOf(ctx.service.create(marketer, post({ partnerId: randomUUID() }), NOW))).toBe("partner_not_found");
    expect(ctx.materials.rows.size).toBe(0);
    const own = await ctx.service.create(marketer, post({ partnerId }), NOW);
    expect(own).toMatchObject({ partnerId, partnerName: "Игровой угол" });
  });

  it("правка заменяет поля и пишется в аудит «было → стало»; вид не меняется; нет такого — 404", async () => {
    const ctx = setup();
    const marketer = await person(ctx, "910015", "marketer");
    const created = await ctx.service.create(marketer, post({ title: "Старое", sort: 5 }), NOW);

    const changed = await ctx.service.update(marketer, created.materialId, post({ title: "Новое", text: "Другой текст", sort: 1 }), NOW);

    expect(changed).toMatchObject({ title: "Новое", text: "Другой текст", sort: 1, kind: "post" });
    const [entry] = ctx.roles.entries.filter((item) => item.action === "partner_material.update");
    expect(entry).toMatchObject({ target: created.materialId, before: { title: "Старое", sort: 5 }, after: { title: "Новое", sort: 1 } });
    expect(await codeOf(ctx.service.update(marketer, created.materialId, post({ kind: "rules" }), NOW))).toBe("validation_failed");
    expect(await codeOf(ctx.service.update(marketer, randomUUID(), post(), NOW))).toBe("partner_material_not_found");
  });

  it("«В архив» прячет материал и пишется в аудит; повтор безвреден; из архива можно вернуть", async () => {
    const ctx = setup();
    const marketer = await person(ctx, "910016", "marketer");
    const created = await ctx.service.create(marketer, post(), NOW);

    const archived = await ctx.service.setArchived(marketer, created.materialId, true, NOW);
    expect(archived.archivedAt).toEqual(NOW);
    expect((await ctx.service.setArchived(marketer, created.materialId, true, new Date(NOW.getTime() + 1))).archivedAt).toEqual(NOW);
    expect(ctx.roles.entries.filter((entry) => entry.action === "partner_material.archive")).toHaveLength(1);
    expect((await ctx.service.setArchived(marketer, created.materialId, false, NOW)).archivedAt).toBeNull();
    expect(ctx.roles.entries.filter((entry) => entry.action === "partner_material.restore")).toHaveLength(1);
    expect(await codeOf(ctx.service.setArchived(marketer, randomUUID(), true, NOW))).toBe("partner_material_not_found");
  });

  it("список для команды — под partners.view и с архивными; завести и править — только с partners.edit", async () => {
    const ctx = setup();
    const marketer = await person(ctx, "910017", "marketer");
    const created = await ctx.service.create(marketer, post(), NOW);
    await ctx.service.setArchived(marketer, created.materialId, true, NOW);

    const finance = await person(ctx, "910018", "finance");
    expect((await ctx.service.list(finance)).materials).toMatchObject([{ materialId: created.materialId, archivedAt: NOW }]);
    expect(await codeOf(ctx.service.create(finance, post(), NOW))).toBe("forbidden");
    expect(await codeOf(ctx.service.update(finance, created.materialId, post(), NOW))).toBe("forbidden");
    expect(await codeOf(ctx.service.setArchived(finance, created.materialId, false, NOW))).toBe("forbidden");

    const moderator = await person(ctx, "910019", "moderator");
    expect(await codeOf(ctx.service.list(moderator))).toBe("forbidden");
    const partner = (await partnerWithCabinet(ctx, "910020")).actor;
    expect(await codeOf(ctx.service.list(partner))).toBe("forbidden");
  });
});

describe("материалы в кабинете партнёра", () => {
  async function seed(ctx: Ctx) {
    const marketer = await person(ctx, "910030", "marketer");
    const a = await partnerWithCabinet(ctx, "910031", "Партнёр А");
    const b = await partnerWithCabinet(ctx, "910032", "Партнёр Б");
    const imageId = await uploadBanner(ctx, marketer);
    const shared = await ctx.service.create(marketer, { kind: "banner", title: "Общий баннер", text: "Подпись", imageId, partnerId: null, sort: 20 }, NOW);
    const rules = await ctx.service.create(marketer, post({ kind: "rules", title: "Правила программы", text: "Правила", sort: 10 }), NOW);
    const forA = await ctx.service.create(marketer, post({ title: "Пост для А", partnerId: a.partnerId, sort: 30 }), NOW);
    const forB = await ctx.service.create(marketer, post({ title: "Пост для Б", partnerId: b.partnerId, sort: 5 }), NOW);
    const archived = await ctx.service.create(marketer, post({ title: "Старый общий", sort: 1 }), NOW);
    await ctx.service.setArchived(marketer, archived.materialId, true, NOW);
    const archivedForA = await ctx.service.create(marketer, post({ title: "Старый для А", partnerId: a.partnerId, sort: 2 }), NOW);
    await ctx.service.setArchived(marketer, archivedForA.materialId, true, NOW);
    return { marketer, a, b, shared, rules, forA, forB, imageId };
  }

  it("партнёр видит общие и свои по порядку; чужих и архивных нет", async () => {
    const ctx = setup();
    const { a, b, shared, rules, forA, forB } = await seed(ctx);

    const mine = await ctx.cabinet.materials(a.actor, {});
    expect(mine.materials.map((item) => item.materialId)).toEqual([rules.materialId, shared.materialId, forA.materialId]);
    expect(mine.viewOnly).toBe(false);
    expect((await ctx.cabinet.materials(b.actor, {})).materials.map((item) => item.materialId)).toEqual([forB.materialId, rules.materialId, shared.materialId]);
  });

  it("в ответе только то, что партнёру нужно: без автора, архива, id партнёра и названия чужого", async () => {
    const ctx = setup();
    const { a, imageId } = await seed(ctx);

    const { materials } = await ctx.cabinet.materials(a.actor, {});

    const banner = materials.find((item) => item.kind === "banner");
    expect(banner).toEqual({ materialId: expect.any(String), kind: "banner", title: "Общий баннер", text: "Подпись", imageId, imageWidth: null, imageHeight: null, shared: true });
    for (const item of materials) expect(Object.keys(item).sort()).toEqual(["imageHeight", "imageId", "imageWidth", "kind", "materialId", "shared", "text", "title"]);
    expect(materials.find((item) => item.title === "Пост для А")?.shared).toBe(false);
  });

  it("режим «глазами партнёра»: команда видит материалы названного партнёра и никого другого, только чтение", async () => {
    const ctx = setup();
    const { marketer, a, b, shared, rules, forA, forB } = await seed(ctx);

    const forSupport = await ctx.cabinet.materials(marketer, { partnerId: a.partnerId });
    expect(forSupport.viewOnly).toBe(true);
    expect(forSupport.materials.map((item) => item.materialId)).toEqual([rules.materialId, shared.materialId, forA.materialId]);
    expect(forSupport.materials.map((item) => item.materialId)).not.toContain(forB.materialId);
    expect((await ctx.cabinet.materials(marketer, { partnerId: b.partnerId })).materials.map((item) => item.materialId)).not.toContain(forA.materialId);
  });

  it("партнёр не откроет чужой кабинет по partnerId; аккаунт без карточки и без роли — отказ", async () => {
    const ctx = setup();
    const { a, b } = await seed(ctx);
    expect(await codeOf(ctx.cabinet.materials(a.actor, { partnerId: b.partnerId }))).toBe("forbidden");
    expect(await codeOf(ctx.cabinet.materials(await person(ctx, "910033", "partner"), {}))).toBe("forbidden");
    expect(await codeOf(ctx.cabinet.materials(await person(ctx, "910034"), {}))).toBe("forbidden");
  });

  it("материал ушёл в архив — из кабинета пропал, вернулся — появился", async () => {
    const ctx = setup();
    const { marketer, a, forA } = await seed(ctx);
    await ctx.service.setArchived(marketer, forA.materialId, true, NOW);
    expect((await ctx.cabinet.materials(a.actor, {})).materials.map((item) => item.materialId)).not.toContain(forA.materialId);
    await ctx.service.setArchived(marketer, forA.materialId, false, NOW);
    expect((await ctx.cabinet.materials(a.actor, {})).materials.map((item) => item.materialId)).toContain(forA.materialId);
  });

  it("материалов нет — пустой список, а не ошибка", async () => {
    const ctx = setup();
    const a = await partnerWithCabinet(ctx, "910035");
    expect(await ctx.cabinet.materials(a.actor, {})).toEqual({ materials: [], viewOnly: false });
  });

  it("кабинет, собранный без хранилища материалов, отвечает понятной ошибкой", async () => {
    const ctx = setup();
    const a = await partnerWithCabinet(ctx, "910036");
    const bare = new PartnerCabinet(new RolesService(loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv), ctx.roles, ctx.accounts), ctx.linked, ctx.partners);
    await expect(bare.materials(a.actor, {})).rejects.toThrow("материалы");
  });
});

describe("выборка материалов партнёра (последняя линия защиты)", () => {
  const row = (patch: Partial<MaterialRow>): MaterialRow => ({
    materialId: randomUUID(),
    kind: "post",
    title: "Пост",
    text: "Текст",
    imageId: null,
    partnerId: null,
    partnerName: null,
    sort: 0,
    createdBy: randomUUID(),
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    imageWidth: null,
    imageHeight: null,
    ...patch,
  });

  it("оставляет общие и свои неархивные, остальное отбрасывает, даже если хранилище отдало лишнее", () => {
    const mine = randomUUID();
    const rows = [row({ title: "общий" }), row({ title: "свой", partnerId: mine, sort: 1 }), row({ title: "чужой", partnerId: randomUUID() }), row({ title: "архив", archivedAt: NOW }), row({ title: "свой архив", partnerId: mine, archivedAt: NOW })];
    expect(materialsVisibleTo(rows, mine).map((item) => item.title)).toEqual(["общий", "свой"]);
  });

  it("порядок — по `sort`, при равенстве — по времени заведения", () => {
    const later = new Date(NOW.getTime() + 1000);
    const rows = [row({ title: "в", sort: 2 }), row({ title: "б", sort: 1, createdAt: later }), row({ title: "а", sort: 1 })];
    expect(materialsVisibleTo(rows, randomUUID()).map((item) => item.title)).toEqual(["а", "б", "в"]);
  });
});

describe("хэш картинки", () => {
  it("id картинки — SHA-256 содержимого: баннер ссылается на него", () => {
    expect(imageIdOf(webpOf(1080, 1080))).toMatch(/^[0-9a-f]{64}$/);
  });
});
