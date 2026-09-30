import { PrismaPg } from "@prisma/adapter-pg";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { ChangelogFanout } from "../src/modules/changelog/changelog-fanout.js";
import { PrismaChangelogRepository } from "../src/modules/changelog/changelog.repository.js";
import { ChangelogService } from "../src/modules/changelog/changelog.service.js";
import { PrismaNotificationsRepository } from "../src/modules/notifications/notifications.repository.js";
import { NotificationsService } from "../src/modules/notifications/notifications.service.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Журнал обновлений на живом Postgres (docs/17-testing-strategy.md §4.2;
 * адрес — TEST_DATABASE_URL, без него пропуск): порядок версий по числам,
 * публикация только черновиков, проверки базы, поколение раздачи, отметка
 * «открывал» только растёт, получатели раздачи и сама раздача без дублей.
 *
 * Аккаунты раздачи — на площадке `web`: раздача идёт всем игрокам площадки,
 * и соседние тесты на общей базе, которые считают строки ленты своих
 * аккаунтов Telegram, её не заметят. Версии — случайные: база общая и между
 * прогонами.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const DAY = 86_400_000;

describe.skipIf(DATABASE_URL === "")("журнал обновлений на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let repository: PrismaChangelogRepository;
  let notifications: NotificationsService;

  const version = (): string => `${String(1000 + Math.floor(Math.random() * 9000))}.${String(Math.floor(Math.random() * 1000))}.0`;

  async function account(platform: "telegram" | "web", seenAt = Date.now()): Promise<string> {
    const created = await accounts.upsert({ platform, platformUserId: String(880_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Журнал", username: null }, seenAt);
    return created.accountId;
  }

  beforeAll(() => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 10, connectionTimeoutMillis: 30_000 }) });
    accounts = new PrismaAccountRepository(prisma);
    repository = new PrismaChangelogRepository(prisma);
    notifications = new NotificationsService(new PrismaNotificationsRepository(prisma));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("версии — по числам; публикуются только черновики своей версии", async () => {
    const major = 1000 + Math.floor(Math.random() * 9000);
    const nine = `${String(major)}.9.0`;
    const ten = `${String(major)}.10.0`;
    const at = new Date();
    const a = await repository.create(crypto.randomUUID(), { version: nine, platforms: [], kind: "added", text: "девятая" }, crypto.randomUUID(), at);
    const b = await repository.create(crypto.randomUUID(), { version: ten, platforms: ["vk", "telegram"], kind: "fixed", text: "десятая" }, crypto.randomUUID(), at);
    const mine = (await repository.all()).filter((entry) => entry.entryId === a.entryId || entry.entryId === b.entryId);
    expect(mine.map((entry) => entry.version)).toEqual([ten, nine]);

    expect(await repository.publish(ten, at)).toBe(1);
    expect(await repository.publish(ten, new Date(at.getTime() + 1_000))).toBe(0);
    const published = (await repository.published()).filter((entry) => entry.entryId === a.entryId || entry.entryId === b.entryId);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ version: ten, platforms: ["vk", "telegram"], publishedAt: at });
    expect(await repository.remove(a.entryId)).toBe(true);
    expect(await repository.byId(a.entryId)).toBeNull();
  });

  it("проверки базы: версия и её числа не расходятся, пустая строка — не изменение", async () => {
    await expect(prisma.$executeRaw`INSERT INTO changelog_entry VALUES (gen_random_uuid(), '0.6.1', 0, 6, 0, '{}', 'added', 'x', NULL, now(), now(), NULL)`).rejects.toThrow(/changelog_entry_version_parts/);
    await expect(prisma.$executeRaw`INSERT INTO changelog_entry VALUES (gen_random_uuid(), '0.6.0', 0, 6, 0, '{}', 'added', '   ', NULL, now(), now(), NULL)`).rejects.toThrow(/changelog_entry_text_not_blank/);
  });

  it("курсор раздачи сдвигает только своё поколение; конец раздачи — окончательный", async () => {
    const release = version();
    const first = new Date(Date.UTC(2026, 8, 30, 10));
    const second = new Date(first.getTime() + 60_000);
    await repository.startRelease(release, ["telegram"], first);
    const cursor = crypto.randomUUID();
    expect(await repository.advanceRelease(release, first, cursor, null)).toBe(true);
    await repository.startRelease(release, ["telegram", "vk"], second);
    expect(await repository.advanceRelease(release, first, crypto.randomUUID(), null)).toBe(false);
    const row = (await repository.releases()).find((candidate) => candidate.version === release);
    expect(row).toMatchObject({ platforms: ["telegram", "vk"], publishedAt: second, cursor: null, doneAt: null });

    expect(await repository.advanceRelease(release, second, cursor, second)).toBe(true);
    expect((await repository.pendingReleases()).some((candidate) => candidate.version === release)).toBe(false);
    expect(await repository.advanceRelease(release, second, null, null)).toBe(false);
  });

  it("черновик из PR: один на ключ даже под гонкой, правленное человеком и удалённое не трогается", async () => {
    const release = version();
    const key = `pr-${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}-1`;
    const line = { sourceKey: key, version: release, kind: "added" as const, platforms: ["telegram" as const], text: "Журнал обновлений" };
    const at = new Date();

    const outcomes = await Promise.all(Array.from({ length: 4 }, () => repository.importDraft(line, at)));
    expect(outcomes.filter((outcome) => outcome === "created")).toHaveLength(1);
    const created = (await repository.all()).find((entry) => entry.sourceKey === key);
    expect(created).toMatchObject({ version: release, platforms: ["telegram"], publishedAt: null, updatedBy: null });

    expect(await repository.importDraft({ ...line, text: "Журнал обновлений в меню" }, at)).toBe("updated");
    await repository.update(created?.entryId ?? "", { ...line, text: "Правка команды" }, crypto.randomUUID(), at);
    expect(await repository.importDraft({ ...line, text: "Снова из PR" }, at)).toBe("kept");
    expect((await repository.byId(created?.entryId ?? ""))?.text).toBe("Правка команды");

    await repository.remove(created?.entryId ?? "");
    expect(await repository.importDraft(line, at)).toBe("removed");
    expect((await repository.all()).some((entry) => entry.sourceKey === key)).toBe(false);
  });

  it("отметка «открывал» только растёт, даже под гонкой", async () => {
    const me = await account("telegram");
    const times = [5, 1, 9, 3].map((minutes) => new Date(Date.UTC(2026, 8, 30, 12, minutes)));
    await Promise.all(times.map((at) => repository.markSeen(me, at)));
    expect(await repository.seenAt(me)).toEqual(new Date(Date.UTC(2026, 8, 30, 12, 9)));
    await repository.markSeen(me, new Date(Date.UTC(2026, 8, 30, 11)));
    expect(await repository.seenAt(me)).toEqual(new Date(Date.UTC(2026, 8, 30, 12, 9)));
  });

  it("получатели: своя площадка, без заблокированных и давно не заходивших, по возрастанию id после курсора", async () => {
    const now = Date.now();
    const active = [await account("web", now), await account("web", now), await account("web", now)].sort();
    const stale = await account("web", now - 200 * DAY);
    const banned = await account("web", now);
    await accounts.setBan(banned, { at: new Date(), reason: "тест" });
    const other = await account("telegram", now);

    const seen: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page: string[] = await accounts.recipientsPage({ platforms: ["web"], seenSince: new Date(now - 90 * DAY), after, limit: 2 });
      if (page.length === 0) break;
      expect([...page].sort()).toEqual(page);
      if (after !== null) expect((page[0] ?? "") > after).toBe(true);
      seen.push(...page);
      after = page[page.length - 1] ?? null;
    }
    for (const id of active) expect(seen).toContain(id);
    for (const id of [stale, banned, other]) expect(seen).not.toContain(id);
    expect(await accounts.recipientsPage({ platforms: [], seenSince: new Date(0), after: null, limit: 10 })).toEqual([]);
  });

  it("раздача: одно уведомление каждому игроку площадки, повтор публикации без дублей", async () => {
    const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);
    const locks = new Map<string, string>();
    const redis = {
      set: async (key: string, value: string) => (locks.has(key) ? null : (locks.set(key, value), "OK")),
      eval: async (_script: string, _keys: number, key: string) => (locks.delete(key) ? 1 : 0),
    } as unknown as Redis;
    const fanout = new ChangelogFanout(config, repository, accounts, notifications, redis);
    const rolesRepository = new MemoryRolesRepository();
    const service = new ChangelogService(repository, accounts, new RolesService(config, rolesRepository, accounts), fanout);
    const owner = await account("web");
    await rolesRepository.grant(owner, "admin", null);
    const actor = { accountId: owner, platform: "web" as const, platformUserId: "owner" };

    const players = [await account("web"), await account("web")];
    const release = version();
    await service.save(actor, { version: release, kind: "added", platforms: ["web"], text: "Для браузера" });
    await service.publish(actor, release);
    // Проходов — до конца раздачи: на общей базе игроков площадки может быть больше пачки.
    while ((await repository.pendingReleases()).some((candidate) => candidate.version === release)) await fanout.tick();

    await service.save(actor, { version: release, kind: "fixed", platforms: ["web"], text: "Ещё строка" });
    await service.publish(actor, release);
    while ((await repository.pendingReleases()).some((candidate) => candidate.version === release)) await fanout.tick();

    for (const id of [owner, ...players]) {
      const rows = await prisma.notification.findMany({ where: { accountId: id, kind: "app_update" }, select: { payload: true, dedupeKey: true } });
      expect(rows).toEqual([{ payload: { version: release }, dedupeKey: `app_update:${release}` }]);
    }
    const page = await service.page({ accountId: players[0] ?? "", platform: "web" }, null, 20);
    expect(page.versions.find((candidate) => candidate.version === release)?.entries.map((line) => line.text)).toEqual(["Для браузера", "Ещё строка"]);
  });
});
