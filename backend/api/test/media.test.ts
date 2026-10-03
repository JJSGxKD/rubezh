import "reflect-metadata";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { ADMIN_CSRF_HEADER, ADMIN_CSRF_VALUE, ADMIN_SESSION_COOKIE } from "../src/modules/admin/admin-cookie.js";
import { AdminMediaController } from "../src/modules/admin/admin-media.controller.js";
import { AdminSessionController } from "../src/modules/admin/admin-session.controller.js";
import { AdminSessionGuard } from "../src/modules/admin/admin-session.guard.js";
import { AdminSessionService } from "../src/modules/admin/admin-session.service.js";
import { ADMIN_SESSION_STORE, hashSessionToken } from "../src/modules/admin/admin-session.store.js";
import { PanelLoginService } from "../src/modules/admin/panel-login.service.js";
import { PANEL_LOGIN_STORE } from "../src/modules/admin/panel-login.store.js";
import { ACCOUNT_REPOSITORY } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { IMAGE_MAX_BYTES, IMAGE_PROFILES, checkImage, imageIdOf, imagePath, inspectWebp } from "../src/modules/media/image-rules.js";
import { MediaController } from "../src/modules/media/media.controller.js";
import { ImageNotFoundError, ImageRejectedError } from "../src/modules/media/media-errors.js";
import { MEDIA_REPOSITORY, type StoredImage } from "../src/modules/media/media.repository.js";
import { ImageCache, MediaService } from "../src/modules/media/media.service.js";
import { PermissionGuard } from "../src/modules/roles/permission.guard.js";
import { ROLES_REPOSITORY } from "../src/modules/roles/roles.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { TelegramAppLinks } from "../src/platforms/telegram/telegram-app-links.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAdminSessionStore } from "./helpers/memory-admin-sessions.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryMedia } from "./helpers/memory-media.js";
import { MemoryPanelLoginStore } from "./helpers/memory-panel-login.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { webp } from "./helpers/webp-samples.js";

/**
 * Картинки из панели (docs/35-stage4-plan.md О42): в базе по хэшу содержимого,
 * отдаются с вечным кешем. Сервер не перекодирует, а проверяет: WebP, размер,
 * стороны по профилю, без анимации и метаданных.
 */

const OWNER_ID = "777000111";
const config = () => loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);

/** Файл RIFF/WEBP с одним блоком: длина RIFF — честная, как у кодировщика. */
function riff(chunk: string, payload: number[], pad = 16): Buffer {
  const body = Buffer.from([...payload, ...new Array<number>(pad).fill(0)]);
  const header = Buffer.alloc(20);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(12 + body.length, 4);
  header.write("WEBP", 8, "latin1");
  header.write(chunk, 12, "latin1");
  header.writeUInt32LE(body.length, 16);
  return Buffer.concat([header, body]);
}

const le16 = (value: number) => [value & 0xff, (value >> 8) & 0xff];
const le24 = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];

function vp8(width: number, height: number): Buffer {
  return riff("VP8 ", [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height)]);
}

function vp8l(width: number, height: number, pad = 16): Buffer {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  return riff("VP8L", [0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff], pad);
}

function vp8x(width: number, height: number, flags: number): Buffer {
  return riff("VP8X", [flags, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)]);
}

interface Setup {
  accounts: MemoryAccountRepository;
  roles: MemoryRolesRepository;
  repository: MemoryMedia;
  service: MediaService;
}

function setup(): Setup {
  const accounts = new MemoryAccountRepository();
  const roles = new MemoryRolesRepository();
  const repository = new MemoryMedia();
  const service = new MediaService(repository, new RolesService(config(), roles, accounts));
  return { accounts, roles, repository, service };
}

async function person(s: Setup, id: string, role?: "game_designer" | "moderator"): Promise<AccountRef> {
  const account = await s.accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Игрок ${id}`, username: null, photoUrl: null }, Date.now());
  if (role !== undefined) await s.roles.grant(account.accountId, role, null);
  return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
}

describe("разбор WebP", () => {
  it("настоящие файлы Chromium: стороны, без анимации и метаданных", () => {
    expect(inspectWebp(webp("square96"))).toEqual({ width: 96, height: 96, animated: false, metadata: false });
    expect(inspectWebp(webp("alpha128"))).toEqual({ width: 128, height: 128, animated: false, metadata: false });
    expect(inspectWebp(webp("wide120x80"))).toEqual({ width: 120, height: 80, animated: false, metadata: false });
  });

  it("простой с потерями и без потерь — тоже: так сжимают другие браузеры", () => {
    expect(inspectWebp(vp8(160, 160))).toMatchObject({ width: 160, height: 160 });
    expect(inspectWebp(vp8l(200, 150))).toMatchObject({ width: 200, height: 150 });
    expect(inspectWebp(vp8x(4096, 1, 0x02))).toMatchObject({ width: 4096, height: 1, animated: true });
    expect(inspectWebp(vp8x(64, 64, 0x08))).toMatchObject({ metadata: true });
  });

  it("не WebP, обрезанный файл, лишний хвост и кадр без стартового кода — не картинка", () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000600000006008060000", "hex");
    expect(inspectWebp(png)).toBeNull();
    const real = webp("square96");
    expect(inspectWebp(real.subarray(0, real.length - 1))).toBeNull();
    expect(inspectWebp(Buffer.concat([real, Buffer.from([0])]))).toBeNull();
    const broken = vp8(96, 96);
    broken[23] = 0x00;
    expect(inspectWebp(broken)).toBeNull();
    expect(inspectWebp(riff("ICCP", [1, 2, 3]))).toBeNull();
    expect(inspectWebp(Buffer.alloc(0))).toBeNull();
  });
});

describe("проверка картинки задания", () => {
  const task = IMAGE_PROFILES.task;

  it("квадрат WebP в пределах — годится", () => {
    expect(checkImage(webp("square96"), task)).toEqual({ ok: true, width: 96, height: 96 });
    expect(checkImage(vp8l(512, 512), task)).toEqual({ ok: true, width: 512, height: 512 });
  });

  it("отказ словами: не квадрат, мелкая, огромная, анимация, метаданные, тяжёлая, не WebP", () => {
    const problem = (bytes: Buffer) => {
      const checked = checkImage(bytes, task);
      return checked.ok ? null : checked.problem;
    };
    expect(problem(webp("wide120x80"))).toBe("Картинка задания — квадрат, а пришло 120×80");
    expect(problem(vp8l(64, 64))).toBe("Картинка задания — не меньше 96 px по стороне");
    expect(problem(vp8l(1024, 1024))).toBe("Картинка задания — не больше 512 px по стороне");
    expect(problem(vp8x(128, 128, 0x02))).toBe("Анимированные картинки не принимаем");
    expect(problem(vp8x(128, 128, 0x04))).toContain("метаданные");
    expect(problem(vp8l(128, 128, IMAGE_MAX_BYTES))).toBe("Файл больше 200 КБ");
    expect(problem(Buffer.from("not an image at all, just some text"))).toBe("Это не WebP или файл повреждён");
  });

  it("id — SHA-256 содержимого: тот же файл — тот же адрес", () => {
    const bytes = webp("square96");
    expect(imageIdOf(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(imageIdOf(Buffer.from(bytes))).toBe(imageIdOf(bytes));
    expect(imagePath(imageIdOf(bytes))).toBe(`/api/v1/media/${imageIdOf(bytes)}.webp`);
  });
});

describe("кеш картинок в памяти", () => {
  const image = (id: string, size: number): StoredImage => ({ imageId: id, width: 1, height: 1, sizeBytes: size, contentType: "image/webp", data: new Uint8Array(size) });

  it("держит объём: уходит та, которую дольше всех не спрашивали; больше объёма — не держит вовсе", () => {
    const cache = new ImageCache(300);
    cache.set(image("a", 100));
    cache.set(image("b", 100));
    cache.set(image("c", 100));
    expect(cache.get("a")?.imageId).toBe("a");
    cache.set(image("d", 100));
    expect(cache.get("b")).toBeUndefined();
    expect(["a", "c", "d"].map((id) => cache.get(id)?.imageId)).toEqual(["a", "c", "d"]);
    expect(cache.size).toEqual({ count: 3, bytes: 300 });
    cache.set(image("huge", 301));
    expect(cache.get("huge")).toBeUndefined();
    expect(cache.size.count).toBe(3);
  });
});

describe("картинки в сервисе", () => {
  it("загрузка: правом профиля, проверкой файла, одна строка на одинаковый файл", async () => {
    const s = setup();
    const designer = await person(s, "501", "game_designer");
    const bytes = webp("square96");
    const meta = await s.service.upload(designer, "task", bytes);
    expect(meta).toEqual({ imageId: imageIdOf(bytes), width: 96, height: 96, sizeBytes: bytes.length });
    expect(await s.service.upload(designer, "task", Buffer.from(bytes))).toEqual(meta);
    expect(s.repository.rows.size).toBe(1);
    expect(s.repository.rows.get(meta.imageId)?.createdBy).toBe(designer.accountId);

    await expect(s.service.upload(designer, "task", webp("wide120x80"))).rejects.toBeInstanceOf(ImageRejectedError);
    const moderator = await person(s, "502", "moderator");
    await expect(s.service.upload(moderator, "task", webp("alpha128"))).rejects.toThrow();
    expect(s.repository.rows.size).toBe(1);
  });

  it("чтение: база — однажды, и для двух запросов разом; нет картинки — null, и она не кешируется", async () => {
    const s = setup();
    const owner = await person(s, OWNER_ID);
    const { imageId } = await s.service.upload(owner, "task", webp("square96"));
    const [first, second] = await Promise.all([s.service.read(imageId), s.service.read(imageId)]);
    expect(first?.imageId).toBe(imageId);
    expect(second).toBe(first);
    expect(await s.service.read(imageId)).toBe(first);
    expect(s.service.peek(imageId)).toBe(first);
    expect(s.repository.reads).toBe(1);

    const missing = "0".repeat(64);
    expect(await s.service.read(missing)).toBeNull();
    expect(await s.service.read(missing)).toBeNull();
    expect(s.repository.reads).toBe(3);
  });

  it("ссылка на картинку: нет такой — «не найдена», не того профиля — отказ словами", async () => {
    const s = setup();
    await expect(s.service.require("f".repeat(64), "task")).rejects.toBeInstanceOf(ImageNotFoundError);
    const wide = webp("wide120x80");
    await s.repository.insert({ imageId: imageIdOf(wide), contentType: "image/webp", width: 120, height: 80, sizeBytes: wide.length, data: wide, createdBy: "x" });
    await expect(s.service.require(imageIdOf(wide), "task")).rejects.toThrow("квадрат");
    const owner = await person(s, OWNER_ID);
    const { imageId } = await s.service.upload(owner, "task", webp("alpha128"));
    await expect(s.service.require(imageId, "task")).resolves.toBeUndefined();
  });
});

describe("картинки по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(s: Setup, store = new MemoryAdminSessionStore()): Promise<NestFastifyApplication> {
    const cfg = loadAppConfig({ NODE_ENV: "development", ...AUTH_ENV, AUTH_DEV_LOGIN: "true", ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    @Module({
      controllers: [MediaController, AdminSessionController, AdminMediaController],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: ACCOUNT_REPOSITORY, useValue: s.accounts },
        { provide: ROLES_REPOSITORY, useValue: s.roles },
        { provide: ADMIN_SESSION_STORE, useValue: store },
        { provide: PANEL_LOGIN_STORE, useValue: new MemoryPanelLoginStore() },
        { provide: MEDIA_REPOSITORY, useValue: s.repository },
        { provide: AppLinks, useValue: new AppLinks([new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })]) },
        MediaService,
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
    return app;
  }

  async function ownerHeaders(server: NestFastifyApplication): Promise<Record<string, string>> {
    const login = await server.inject({ method: "POST", url: "/api/v1/admin/session/dev", payload: { devUser: `dev-${OWNER_ID}:Владелец` } });
    const cookie = `${ADMIN_SESSION_COOKIE}=${/rubezh_admin_session=([^;]+)/.exec(String(login.headers["set-cookie"]))?.[1] ?? ""}`;
    return { cookie, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE };
  }

  it("панель: загрузка WebP base64 — id по хэшу; не квадрат — 400 с причиной; мусор и лишнее поле — 400; без заголовка панели и без права — 403", async () => {
    const s = setup();
    const store = new MemoryAdminSessionStore();
    const server = await start(s, store);
    const headers = await ownerHeaders(server);
    const bytes = webp("square96");
    const url = "/api/v1/admin/media/images";

    expect((await server.inject({ method: "POST", url, payload: { profile: "task", data: bytes.toString("base64") } })).statusCode).toBe(401);
    expect((await server.inject({ method: "POST", url, headers: { cookie: headers.cookie ?? "" }, payload: { profile: "task", data: bytes.toString("base64") } })).statusCode).toBe(403);
    expect((await server.inject({ method: "POST", url, headers, payload: { profile: "task", data: "не base64!" } })).statusCode).toBe(400);
    expect((await server.inject({ method: "POST", url, headers, payload: { profile: "slide", data: bytes.toString("base64") } })).statusCode).toBe(400);
    expect((await server.inject({ method: "POST", url, headers, payload: { profile: "task", data: bytes.toString("base64"), name: "x" } })).statusCode).toBe(400);

    const wide = await server.inject({ method: "POST", url, headers, payload: { profile: "task", data: webp("wide120x80").toString("base64") } });
    expect(wide.statusCode).toBe(400);
    expect(wide.json()).toMatchObject({ error: { code: "image_rejected", message: "Картинка задания — квадрат, а пришло 120×80" } });

    const uploaded = await server.inject({ method: "POST", url, headers, payload: { profile: "task", data: bytes.toString("base64") } });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json().data).toEqual({ imageId: imageIdOf(bytes), width: 96, height: 96, sizeBytes: bytes.length });

    const preview = await server.inject({ method: "GET", url: `/api/v1/admin/media/${imageIdOf(bytes)}.webp`, headers });
    expect(preview.statusCode).toBe(200);
    expect(preview.rawPayload.equals(bytes)).toBe(true);
    expect((await server.inject({ method: "GET", url: `/api/v1/admin/media/${imageIdOf(bytes)}.webp` })).statusCode).toBe(401);

    const moderator = await s.accounts.upsert({ platform: "telegram", platformUserId: "600001", displayName: "Мод", username: null, photoUrl: null }, Date.now());
    await s.roles.grant(moderator.accountId, "moderator", null);
    await store.put(hashSessionToken("mod"), { accountId: moderator.accountId, platform: "telegram", platformUserId: "600001", issuedAtMs: 1, expiresAtMs: Date.now() + 60_000 });
    const denied = await server.inject({ method: "POST", url, headers: { cookie: `${ADMIN_SESSION_COOKIE}=mod`, [ADMIN_CSRF_HEADER]: ADMIN_CSRF_VALUE }, payload: { profile: "task", data: webp("alpha128").toString("base64") } });
    expect(denied.statusCode).toBe(403);
    expect(s.repository.rows.size).toBe(1);
  });

  it("игрок: картинка с вечным кешем и ETag, повтор — 304; кривое имя и неизвестная — 404", async () => {
    const s = setup();
    const owner = await person(s, OWNER_ID);
    const bytes = webp("alpha128");
    const { imageId } = await s.service.upload(owner, "task", bytes);
    const server = await start(s);

    const got = await server.inject({ method: "GET", url: imagePath(imageId) });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("image/webp");
    expect(got.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(got.headers.etag).toBe(`"${imageId}"`);
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    expect(got.rawPayload.equals(bytes)).toBe(true);

    for (const tag of [`"${imageId}"`, `W/"${imageId}"`, `"other", "${imageId}"`]) {
      const again = await server.inject({ method: "GET", url: imagePath(imageId), headers: { "if-none-match": tag } });
      expect(again.statusCode).toBe(304);
      expect(again.rawPayload.length).toBe(0);
    }
    expect((await server.inject({ method: "GET", url: imagePath(imageId), headers: { "if-none-match": '"other"' } })).statusCode).toBe(200);

    expect((await server.inject({ method: "GET", url: `/api/v1/media/${imageId}.png` })).statusCode).toBe(404);
    expect((await server.inject({ method: "GET", url: "/api/v1/media/..%2F..%2Fetc%2Fpasswd" })).statusCode).toBe(404);
    const unknown = await server.inject({ method: "GET", url: imagePath("a".repeat(64)) });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: { code: "image_not_found" } });
  });

  it("в базу ходит только то, чего нет в памяти: перебор имён упирается в лимит, а уже прочитанная картинка — нет", async () => {
    const s = setup();
    const owner = await person(s, OWNER_ID);
    const { imageId } = await s.service.upload(owner, "task", webp("square96"));
    const server = await start(s);
    expect((await server.inject({ method: "GET", url: imagePath(imageId) })).statusCode).toBe(200);
    const readsBefore = s.repository.reads;

    // Первый показ своей картинки — тоже поход в базу: из 120 в минуту остаётся 119.
    const statuses: number[] = [];
    for (let index = 0; index < 120; index += 1) {
      const name = index.toString(16).padStart(64, "0");
      statuses.push((await server.inject({ method: "GET", url: imagePath(name) })).statusCode);
    }
    expect(statuses.slice(0, 119).every((status) => status === 404)).toBe(true);
    expect(statuses[119]).toBe(429);
    expect(s.repository.reads - readsBefore).toBe(119);

    // Картинка, которую реплика уже отдавала, — из памяти, и лимит её не держит.
    expect((await server.inject({ method: "GET", url: imagePath(imageId) })).statusCode).toBe(200);
    expect(s.repository.reads - readsBefore).toBe(119);
  });
});
