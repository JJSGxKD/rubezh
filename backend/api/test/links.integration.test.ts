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
 * сессия с `start_ref` клика — считается ссылке запуском. Без базы — пропуск.
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

  it("клики и запуски по ним — в статистике ссылки", async () => {
    const code = newLinkCode();
    await links.create({ code, platform: "telegram", campaign: "launch", source: "tg", medium: null, note: null, createdBy: null });
    expect(await links.byCode(code)).toMatchObject({ code, campaign: "launch", platform: "telegram" });

    const clickIds = [newClickId(), newClickId()];
    for (const clickId of clickIds) {
      await links.recordClick({ clickId, linkCode: code, at: new Date(), utm: { source: "tg", medium: null, campaign: null, content: null, term: null }, refererHost: "t.me", deviceClass: "mobile", ipPrefix: "198.51.100.0/24", language: "ru-RU" });
    }

    const accounts = new PrismaAccountRepository(prisma);
    const account = await accounts.upsert({ platform: "telegram", platformUserId: String(980_000_000 + Math.floor(Math.random() * 9_000_000)), displayName: "Кликнувший", username: null, photoUrl: null }, Date.now());
    await new PrismaSessionsRepository(prisma).record({
      sessionId: randomUUID(),
      accountId: account.accountId,
      platform: "telegram",
      place: "miniapp",
      startKind: "click",
      startParam: `c-${clickIds[0]}`,
      startRef: clickIds[0] ?? null,
      clientPlatform: "android",
      clientVersion: "8.0",
      deviceClass: "mobile",
      os: "android",
      ipPrefix: "198.51.100.0/24",
      startedAt: new Date().toISOString(),
    });

    const stats = (await links.list(500)).find((row) => row.code === code);
    expect(stats).toMatchObject({ clicks: 2, clicks30d: 2, launches: 1 });
  });
});
