import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaSessionsRepository } from "../src/modules/attribution/sessions.repository.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { newClickId, newLinkCode } from "../src/modules/links/link-code.js";
import { PrismaLinksRepository } from "../src/modules/links/links.repository.js";

/**
 * Ссылки и клики на живом Postgres: клик ложится строкой, а запуск по нему —
 * сессия с `start_ref` клика — считается ссылке запуском. Запуск по прямой
 * ссылке (`start_kind = link`, `start_ref` — код ссылки) считается отдельно.
 * Без базы — пропуск.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

describe.skipIf(DATABASE_URL === "")("ссылки на живом Postgres", () => {
  let prisma: PrismaClient;
  let links: PrismaLinksRepository;

  beforeAll(() => {
    prisma = createPrisma(loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv));
    links = new PrismaLinksRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function launch(sessions: PrismaSessionsRepository, accountId: string, startKind: "click" | "link", startRef: string): Promise<void> {
    await sessions.record({
      sessionId: randomUUID(),
      accountId,
      platform: "telegram",
      place: "miniapp",
      startKind,
      startParam: `${startKind === "click" ? "c" : "l"}-${startRef}`,
      startRef,
      clientPlatform: "android",
      clientVersion: "8.0",
      deviceClass: "mobile",
      os: "android",
      ipPrefix: "198.51.100.0/24",
      startedAt: new Date().toISOString(),
    });
  }

  it("клики и запуски по ним — в статистике ссылки; прямые запуски — отдельным числом", async () => {
    const code = newLinkCode();
    await links.create({ code, platform: "telegram", campaign: "launch", source: "tg", medium: null, note: null, createdBy: null, network: null, registrationOn: "first_run" });
    expect(await links.byCode(code)).toMatchObject({ code, campaign: "launch", platform: "telegram", target: "app" });

    const clickIds = [newClickId(), newClickId()];
    for (const clickId of clickIds) {
      await links.recordClick({ clickId, linkCode: code, at: new Date(), utm: { source: "tg", medium: null, campaign: null, content: null, term: null }, refererHost: "t.me", deviceClass: "mobile", ipPrefix: "198.51.100.0/24", language: "ru-RU", networkParams: null });
    }

    const accounts = new PrismaAccountRepository(prisma);
    const sessions = new PrismaSessionsRepository(prisma);
    const newAccount = async (name: string) =>
      (await accounts.upsert({ platform: "telegram", platformUserId: String(980_000_000 + Math.floor(Math.random() * 9_000_000)), displayName: name, username: null, photoUrl: null }, Date.now())).accountId;
    // Две сессии по кликам — два запуска; одна по прямой ссылке — один прямой.
    await launch(sessions, await newAccount("Кликнувший 1"), "click", clickIds[0] ?? "");
    await launch(sessions, await newAccount("Кликнувший 2"), "click", clickIds[1] ?? "");
    const direct = await newAccount("Прямой");
    await launch(sessions, direct, "link", code);

    const stats = (await links.list(500)).find((row) => row.code === code);
    expect(stats).toMatchObject({ clicks: 2, clicks30d: 2, launches: 2, directLaunches: 1 });

    // Тот же игрок по прямой ссылке ещё раз — всё ещё один; чужой код — не этой ссылки.
    await launch(sessions, direct, "link", code);
    await launch(sessions, await newAccount("Чужой"), "link", newLinkCode());
    expect((await links.list(500)).find((row) => row.code === code)).toMatchObject({ launches: 2, directLaunches: 1 });
  });

  it("у ссылки без кликов прямые запуски всё равно считаются", async () => {
    const code = newLinkCode();
    await links.create({ code, platform: "telegram", campaign: "direct-only", source: null, medium: null, note: null, createdBy: null, network: null, registrationOn: "first_run", target: "bot" });
    const accounts = new PrismaAccountRepository(prisma);
    const account = await accounts.upsert({ platform: "telegram", platformUserId: String(970_000_000 + Math.floor(Math.random() * 9_000_000)), displayName: "Прямой без клика", username: null, photoUrl: null }, Date.now());
    await launch(new PrismaSessionsRepository(prisma), account.accountId, "link", code);

    expect((await links.list(500)).find((row) => row.code === code)).toMatchObject({ target: "bot", clicks: 0, launches: 0, directLaunches: 1 });
  });

  it("первое касание по прямой ссылке — вид link с кодом ссылки, как у клика", async () => {
    const code = newLinkCode();
    await links.create({ code, platform: "telegram", campaign: "touch", source: null, medium: null, note: null, createdBy: null, network: null, registrationOn: "first_run" });
    const accounts = new PrismaAccountRepository(prisma);
    const sessions = new PrismaSessionsRepository(prisma);
    const account = await accounts.upsert({ platform: "telegram", platformUserId: String(960_000_000 + Math.floor(Math.random() * 9_000_000)), displayName: "Касание", username: null, photoUrl: null }, Date.now());
    await launch(sessions, account.accountId, "link", code);

    await expect(sessions.acquisition(account.accountId)).resolves.toMatchObject({ firstStartKind: "link", firstStartRef: code, lastStartKind: "link", lastStartRef: code });
  });

  it("retarget меняет цель и возвращает запись; чужого кода нет — null", async () => {
    const code = newLinkCode();
    await links.create({ code, platform: "telegram", campaign: "retarget", source: null, medium: null, note: null, createdBy: null, network: null, registrationOn: "first_run" });
    expect(await links.retarget(code, "landing")).toMatchObject({ code, target: "landing" });
    expect(await links.byCode(code)).toMatchObject({ target: "landing" });
    expect(await links.retarget(newLinkCode(), "bot")).toBeNull();
  });
});
