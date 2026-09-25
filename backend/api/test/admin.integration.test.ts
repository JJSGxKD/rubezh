import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { closeRedis } from "../src/infra/redis.js";
import { hashSessionToken, RedisAdminSessionStore } from "../src/modules/admin/admin-session.store.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaDiagnosticsRepository } from "../src/modules/diagnostics/diagnostics.repository.js";
import { PrismaExportRepository } from "../src/modules/export/export.repository.js";
import { PrismaFunnelRepository } from "../src/modules/funnel/funnel.repository.js";
import { PrismaPurchasesRepository } from "../src/modules/payments/purchases.repository.js";
import { PrismaRolesRepository } from "../src/modules/roles/roles.repository.js";
import { PrismaRunsRepository } from "../src/modules/runs/runs.repository.js";
import { DEVICE } from "./helpers/bench-report.js";
import { redisDatabase } from "./helpers/redis-database.js";

/**
 * Методы соседних модулей, добавленные для панели, и сессии панели — на живых
 * Postgres и Redis (docs/17-testing-strategy.md §4.2; адреса —
 * TEST_DATABASE_URL и PLAYTEST_TEST_REDIS_URL, без них пропуск).
 *
 * Память этого не покажет: поиск по имени без учёта регистра и по началу
 * юзернейма — дело базы; `panel` в перечислении источника выгрузки —
 * миграция; срок жизни сессии в Redis — `EX`.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 11);
const live = DATABASE_URL !== "" && REDIS_URL !== "";

describe.skipIf(!live)("панель на живых Postgres и Redis", () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let accounts: PrismaAccountRepository;
  const marker = `adm${Date.now().toString(36)}`;

  const telegramId = (): string => String(910_000_000 + Math.floor(Math.random() * 80_000_000));

  async function account(patch: { displayName?: string; username?: string | null } = {}) {
    return await accounts.upsert(
      { platform: "telegram", platformUserId: telegramId(), displayName: patch.displayName ?? `Игрок ${marker}`, username: patch.username ?? null, photoUrl: null },
      Date.now(),
    );
  }

  beforeAll(async () => {
    prisma = createPrisma(loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv));
    accounts = new PrismaAccountRepository(prisma);
    redis = new Redis(REDIS_URL);
    await redis.flushdb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await closeRedis(redis);
  });

  it("поиск аккаунтов: по идентификатору точно, по юзернейму с начала, по имени без учёта регистра", async () => {
    const named = await account({ displayName: `Странник ${marker}`, username: `wanderer_${marker}` });
    const other = await account({ displayName: `Гость ${marker}` });

    expect((await accounts.search(named.platformUserId, 10)).map((row) => row.accountId)).toEqual([named.accountId]);
    expect((await accounts.search(`@WANDERER_${marker}`, 10)).map((row) => row.accountId)).toEqual([named.accountId]);
    expect((await accounts.search(`странник ${marker}`, 10)).map((row) => row.accountId)).toEqual([named.accountId]);
    const both = await accounts.search(marker, 10);
    expect(both.map((row) => row.accountId).sort()).toEqual([named.accountId, other.accountId].sort());
    expect(await accounts.search("   ", 10)).toEqual([]);
  });

  it("блокировка и снятие — в аккаунте, несуществующий — null", async () => {
    const target = await account();
    const at = new Date("2026-09-26T10:00:00Z");
    const banned = await accounts.setBan(target.accountId, { at, reason: "накрутка" });
    expect(banned).toMatchObject({ bannedAt: at, banReason: "накрутка" });
    const cleared = await accounts.setBan(target.accountId, null);
    expect(cleared).toMatchObject({ bannedAt: null, banReason: null });
    expect(await accounts.setBan(randomUUID(), null)).toBeNull();
  });

  it("вехи аккаунта и отчёт воронки читаются из репозитория", async () => {
    const funnel = new PrismaFunnelRepository(prisma);
    const target = await account();
    expect(await funnel.milestones(target.accountId)).toBeNull();

    const at = new Date("2026-09-26T09:00:00Z");
    await funnel.entered(target.accountId, at);
    await funnel.runRecorded(target.accountId, new Date(at.getTime() + 60_000));
    expect(await funnel.milestones(target.accountId)).toMatchObject({ enteredAt: at, runsRecorded: 1, runs2At: null });

    const rows = await funnel.report(new Date(at.getTime() - 1000), new Date(at.getTime() + 1000));
    expect(rows.reduce((sum, row) => sum + row.accounts, 0)).toBeGreaterThanOrEqual(1);
  });

  it("покупки аккаунта — свежие первыми, чужие не попадают", async () => {
    const runs = new PrismaRunsRepository(prisma);
    const purchases = new PrismaPurchasesRepository(prisma);
    const target = await account();
    const stranger = await account();
    const runId = `run-${randomUUID()}`;
    await runs.start({ runId, accountId: target.accountId, difficulty: "easy", startingWeaponId: "bolt", contentHash: "c", startedAt: new Date() });
    const strangerRun = `run-${randomUUID()}`;
    await runs.start({ runId: strangerRun, accountId: stranger.accountId, difficulty: "easy", startingWeaponId: "bolt", contentHash: "c", startedAt: new Date() });

    for (const [continueNo, invoicedAt] of [
      [1, new Date("2026-09-26T10:00:00Z")],
      [2, new Date("2026-09-26T11:00:00Z")],
    ] as const) {
      await purchases.openInvoice({ purchaseId: randomUUID(), accountId: target.accountId, runId, continueNo, elapsedSec: 60 * continueNo, priceStars: 1, chargedStars: 1, mode: "test", invoicedAt });
    }
    await purchases.openInvoice({ purchaseId: randomUUID(), accountId: stranger.accountId, runId: strangerRun, continueNo: 1, elapsedSec: 10, priceStars: 1, chargedStars: 1, mode: "test", invoicedAt: new Date() });

    const mine = await purchases.byAccount(target.accountId, 10);
    expect(mine.map((row) => row.continueNo)).toEqual([2, 1]);
    expect(mine.every((row) => row.accountId === target.accountId)).toBe(true);
    expect(await purchases.byAccount(target.accountId, 1)).toHaveLength(1);
  });

  it("выданные роли читаются списком с тем, кто выдал", async () => {
    const roles = new PrismaRolesRepository(prisma);
    const target = await account();
    const granter = await account();
    await roles.grant(target.accountId, "analyst", granter.accountId);

    const mine = (await roles.assignments()).filter((row) => row.accountId === target.accountId);
    expect(mine).toEqual([expect.objectContaining({ role: "analyst", grantedBy: granter.accountId })]);
    expect(mine[0]?.grantedAt).toBeInstanceOf(Date);
  });

  it("отчёты диагностики: список по фильтрам без payload и отчёт целиком", async () => {
    const reports = new PrismaDiagnosticsRepository(prisma);
    const installId = `${marker}-diag`;
    const receivedAt = new Date("2026-09-26T12:00:00Z");
    const record = (kind: "bench" | "run", appVersion: string, offsetMs: number) => ({
      reportId: randomUUID(),
      kind,
      schemaVersion: "test",
      appVersion,
      contentHash: null,
      installId,
      platformUserId: "123",
      platform: "telegram" as const,
      device: DEVICE,
      summary: { peakObjects: 5 },
      payload: { heavy: "x".repeat(10) },
      sizeBytes: 10,
      occurredAt: new Date(receivedAt.getTime() + offsetMs),
      receivedAt: new Date(receivedAt.getTime() + offsetMs),
    });
    const bench = record("bench", `9.9.${marker}`, 0);
    const run = record("run", `9.9.${marker}`, 1000);
    await reports.insert(bench);
    await reports.insert(run);

    const all = await reports.list({ appVersion: `9.9.${marker}`, limit: 10 });
    expect(all.map((row) => row.reportId)).toEqual([run.reportId, bench.reportId]);
    expect(all[0]).not.toHaveProperty("payload");
    expect((await reports.list({ appVersion: `9.9.${marker}`, kind: "bench", limit: 10 })).map((row) => row.reportId)).toEqual([bench.reportId]);
    expect((await reports.list({ appVersion: `9.9.${marker}`, before: run.receivedAt, limit: 10 })).map((row) => row.reportId)).toEqual([bench.reportId]);

    const found = await reports.find(run.reportId);
    expect(found).toMatchObject({ reportId: run.reportId, kind: "run", payload: { heavy: "x".repeat(10) }, device: DEVICE });
    expect(await reports.find(randomUUID())).toBeNull();
    await prisma.diagnosticReport.deleteMany({ where: { installId } });
  });

  it("журнал выгрузок принимает источник «панель» и отдаёт свежие первыми", async () => {
    const journal = new PrismaExportRepository(prisma);
    const requestedBy = `p-${marker}`;
    const exportId = randomUUID();
    await journal.start({ exportId, source: "panel", requestedBy, period: { from: null, to: new Date("2026-09-26T00:00:00Z") } });
    await journal.finish(exportId, { status: "sent", events: 3, reports: 1, sizeBytes: 42, parts: 1, error: null });

    const recent = await journal.recent(50);
    const mine = recent.find((row) => row.exportId === exportId);
    expect(mine).toMatchObject({ source: "panel", requestedBy, status: "sent", events: 3, sizeBytes: 42, period: { from: null } });
    expect(recent[0]?.createdAt.getTime()).toBeGreaterThanOrEqual(recent[recent.length - 1]?.createdAt.getTime() ?? 0);
    await prisma.dataExport.deleteMany({ where: { requestedBy } });
  });

  it("сессии панели в Redis: срок жизни, выход, отзыв по аккаунту", async () => {
    const store = new RedisAdminSessionStore(redis);
    const accountId = randomUUID();
    const session = { accountId, platform: "telegram" as const, platformUserId: "555", issuedAtMs: Date.now(), expiresAtMs: Date.now() + 60_000 };
    const first = hashSessionToken("first");
    const second = hashSessionToken("second");
    await store.put(first, session);
    await store.put(second, { ...session, expiresAtMs: Date.now() + 120_000 });

    expect(await store.get(first)).toEqual(session);
    expect(await redis.ttl(`admin:session:${first}`)).toBeLessThanOrEqual(60);
    // Набор аккаунта живёт не короче самой долгой сессии.
    expect(await redis.ttl(`admin:sessions:${accountId}`)).toBeGreaterThan(60);

    await store.delete(first);
    expect(await store.get(first)).toBeNull();
    expect(await redis.sismember(`admin:sessions:${accountId}`, first)).toBe(0);

    await redis.set(`admin:session:${hashSessionToken("broken")}`, "не json");
    expect(await store.get(hashSessionToken("broken"))).toBeNull();

    expect(await store.revokeAll(accountId)).toBe(1);
    expect(await store.get(second)).toBeNull();
    expect(await store.revokeAll(accountId)).toBe(0);
  });
});
