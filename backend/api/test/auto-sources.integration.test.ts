import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { SessionRecorder } from "../src/modules/attribution/session-recorder.js";
import { PrismaSessionsRepository } from "../src/modules/attribution/sessions.repository.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { AuthHooks } from "../src/modules/auth/auth-hooks.js";
import { AuthService } from "../src/modules/auth/auth.service.js";
import { newLinkCode } from "../src/modules/links/link-code.js";
import { PrismaAutoSourcesRepository, UNKNOWN_KEYS_MAX } from "../src/modules/links/auto-sources.repository.js";
import { AutoSourcesService } from "../src/modules/links/auto-sources.service.js";
import { PrismaLinksRepository } from "../src/modules/links/links.repository.js";
import { launchVerifiersFor } from "../src/platforms/platforms.module.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { signInitData } from "./helpers/init-data.js";
import { MemoryRefreshStore } from "./helpers/memory-auth.js";
import { panelSettings } from "./helpers/settings.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Автоисточники и сводка незнакомых ключей на живом Postgres (Р116, T-0179; адрес —
 * TEST_DATABASE_URL, без него пропуск). Redis тесту не нужен: сессии пишутся напрямую, как при
 * недоступной очереди.
 *
 * Строки автоисточников и сводка ключей принадлежат только этому файлу, поэтому перед каждым
 * тестом они стираются: потолок считается по всем автоисточникам суток, а остатки прошлого
 * прогона заняли бы его места. Ключи пар в тестах свои для каждого прогона: сессии прошлых
 * прогонов не должны попасть в числа запусков.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const DAY = 86_400_000;

describe.skipIf(DATABASE_URL === "")("автоисточники на живом Postgres", () => {
  let prisma: PrismaClient;
  let repository: PrismaAutoSourcesRepository;
  let links: PrismaLinksRepository;
  let sessions: PrismaSessionsRepository;
  let accounts: PrismaAccountRepository;
  let service: AutoSourcesService;
  const settings = panelSettings();
  /** метка прогона: ключи пар не пересекаются с остатками прошлых запусков */
  const run = randomUUID().replaceAll("-", "").slice(0, 8);

  beforeAll(() => {
    prisma = testPrisma(DATABASE_URL, 8);
    repository = new PrismaAutoSourcesRepository(prisma);
    links = new PrismaLinksRepository(prisma);
    sessions = new PrismaSessionsRepository(prisma);
    accounts = new PrismaAccountRepository(prisma);
    service = new AutoSourcesService(repository, settings);
  });

  beforeEach(async () => {
    settings.set("links.auto-daily-cap", 20);
    await prisma.$executeRaw`DELETE FROM link WHERE auto = true`;
    await prisma.$executeRaw`DELETE FROM start_param_key`;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const autoLinks = () => prisma.link.findMany({ where: { auto: true }, orderBy: { createdAt: "asc" } });
  const keysTable = () => prisma.startParamKey.findMany({ orderBy: { key: "asc" } });

  function ensureInput(autoKey: string, patch: { cap?: number; now?: Date } = {}) {
    return { autoKey, source: autoKey, campaign: "auto", medium: null, partnerTag: null, platform: "telegram" as const, now: patch.now ?? new Date(), cap: patch.cap ?? 20 };
  }

  const launch = (startParam: string | null, at = new Date()) => ({ startParam, platform: "telegram" as const, startedAt: at.toISOString() });

  async function account(): Promise<string> {
    const created = await accounts.upsert({ platform: "telegram", platformUserId: String(Math.floor(Math.random() * 1e12)), displayName: "Новичок", username: null, photoUrl: null }, Date.now());
    return created.accountId;
  }

  async function taggedSession(accountId: string, startParam: string, startRef: string): Promise<void> {
    await sessions.record({
      sessionId: randomUUID(),
      accountId,
      platform: "telegram",
      place: "miniapp",
      startKind: "tagged",
      startParam,
      startRef,
      clientPlatform: "android",
      clientVersion: "8.0",
      deviceClass: "mobile",
      os: "android",
      ipPrefix: "198.51.100.0/24",
      startedAt: new Date().toISOString(),
    });
  }

  describe("создание под потолком", () => {
    it("20 параллельных регистраций разных ключей при потолке 5 — ровно пять строк", async () => {
      settings.set("links.auto-daily-cap", 5);

      const outcomes = await Promise.all(Array.from({ length: 20 }, (_, index) => service.onSession(launch(`src-p${run}${String(index)}`))));

      expect(outcomes.filter((outcome) => outcome === "created")).toHaveLength(5);
      expect(outcomes.filter((outcome) => outcome === "capped")).toHaveLength(15);
      expect(await autoLinks()).toHaveLength(5);
    });

    it("20 параллельных регистраций одного ключа — одна строка", async () => {
      const outcomes = await Promise.all(Array.from({ length: 20 }, () => service.onSession(launch(`src-s${run}_cmp-oct`))));

      expect(outcomes.filter((outcome) => outcome === "created")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === "existing")).toHaveLength(19);
      expect(await autoLinks()).toHaveLength(1);
    });

    it("источник — строка link: пометка «авто», поля из пар, цель — приложение, без владельца и сети", async () => {
      const before = Date.now();
      await service.onSession(launch(`src-t${run}_cmp-oct_plc-post_prt-ivan`));

      const [row, ...rest] = await autoLinks();

      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        auto: true,
        autoKey: `src-t${run}_cmp-oct_plc-post_prt-ivan`,
        source: `t${run}`,
        campaign: "oct",
        medium: "post",
        partnerTag: "ivan",
        platform: "telegram",
        target: "app",
        network: null,
        createdBy: null,
        partnerId: null,
        title: null,
        hiddenAt: null,
      });
      expect(row?.code).toMatch(/^[A-Za-z0-9]{10}$/);
      expect(row?.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    });

    it("порядок и регистр пар — тот же источник", async () => {
      await service.onSession(launch(`src-o${run}_cmp-oct`));
      await service.onSession(launch(`CMP-Oct_SRC-O${run.toUpperCase()}`));

      expect(await autoLinks()).toHaveLength(1);
    });

    it("потолок 0 — не создаётся ни один, а запуск всё равно записывается", async () => {
      settings.set("links.auto-daily-cap", 0);
      const me = await account();
      await taggedSession(me, `src-z${run}`, `src-z${run}`);

      await expect(service.onSession(launch(`src-z${run}`))).resolves.toBe("capped");

      expect(await autoLinks()).toEqual([]);
      expect(await prisma.accountSession.count({ where: { accountId: me, startKind: "tagged" } })).toBe(1);
    });

    it("потолок — за скользящие сутки: источник старше суток место не занимает, моложе — занимает", async () => {
      const now = new Date();
      await expect(repository.ensure(ensureInput(`src-old${run}`, { cap: 1, now: new Date(now.getTime() - 25 * 3_600_000) }))).resolves.toBe("created");
      await expect(repository.ensure(ensureInput(`src-new${run}`, { cap: 1, now }))).resolves.toBe("created");
      await expect(repository.ensure(ensureInput(`src-more${run}`, { cap: 1, now }))).resolves.toBe("capped");
      expect((await autoLinks()).map((row) => row.autoKey)).toEqual([`src-old${run}`, `src-new${run}`]);
    });

    it("скрытый источник: запуск не создаёт нового, не снимает скрытие и место под потолком занимает", async () => {
      settings.set("links.auto-daily-cap", 1);
      await service.onSession(launch(`src-h${run}`));
      const hiddenAt = new Date(Date.now() - 5_000);
      await prisma.$executeRaw`UPDATE link SET hidden_at = ${hiddenAt} WHERE auto_key = ${`src-h${run}`}`;

      await expect(service.onSession(launch(`src-h${run}`))).resolves.toBe("existing");
      await expect(service.onSession(launch(`src-other${run}`))).resolves.toBe("capped");

      const rows = await autoLinks();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.hiddenAt).toEqual(hiddenAt);
    });

    it("ключ источника уникален в базе: вторая строка с тем же набором не вставляется", async () => {
      await service.onSession(launch(`src-u${run}`));

      await expect(prisma.link.create({ data: { code: newLinkCode(), campaign: "auto", auto: true, autoKey: `src-u${run}` } })).rejects.toMatchObject({ code: "P2002" });
    });

    it("прежние поля ссылок команды не задеты: у них пометки нет, названия и скрытия тоже", async () => {
      const code = newLinkCode();
      await links.create({ code, platform: "telegram", campaign: "launch", source: "tg", medium: null, note: null, createdBy: null, network: null, registrationOn: "first_run" });

      expect(await links.byCode(code)).toMatchObject({ code, auto: false, autoKey: null, partnerTag: null, title: null, hiddenAt: null });
      expect((await autoLinks()).some((row) => row.code === code)).toBe(false);
    });
  });

  describe("сводка незнакомых ключей", () => {
    it("счётчик растёт, последний раз обновляется, первый и значения не сохраняются", async () => {
      const first = new Date(Date.now() - 3_600_000);
      const later = new Date();

      await repository.noteUnknownKeys(["zzz", "yyy"], first);
      await repository.noteUnknownKeys(["zzz"], later);

      expect(await keysTable()).toEqual([
        { key: "yyy", hits: 1, firstAt: first, lastAt: first },
        { key: "zzz", hits: 2, firstAt: first, lastAt: later },
      ]);
    });

    it("запоздавшее задание время «последний раз» назад не двигает", async () => {
      const later = new Date();
      await repository.noteUnknownKeys(["zzz"], later);

      await repository.noteUnknownKeys(["zzz"], new Date(later.getTime() - DAY));

      expect((await keysTable())[0]).toMatchObject({ hits: 2, lastAt: later });
    });

    it("201-й ключ не добавляется, а уже известные в полной сводке считаются", async () => {
      for (let index = 0; index < UNKNOWN_KEYS_MAX; index++) await repository.noteUnknownKeys([`kk${String(index)}`], new Date());
      expect(await keysTable()).toHaveLength(UNKNOWN_KEYS_MAX);

      await repository.noteUnknownKeys(["overflow", "kk0"], new Date());

      const table = await keysTable();
      expect(table).toHaveLength(UNKNOWN_KEYS_MAX);
      expect(table.find((row) => row.key === "overflow")).toBeUndefined();
      expect(table.find((row) => row.key === "kk0")?.hits).toBe(2);
    });

    it("250 новых ключей параллельно — ровно 200 строк", async () => {
      await Promise.all(Array.from({ length: 250 }, (_, index) => repository.noteUnknownKeys([`pp${String(index)}`], new Date())));

      expect(await keysTable()).toHaveLength(UNKNOWN_KEYS_MAX);
    });

    it("один ключ из 20 параллельных запусков — одна строка и 20 попаданий", async () => {
      await Promise.all(Array.from({ length: 20 }, () => repository.noteUnknownKeys(["zzz"], new Date())));

      expect(await keysTable()).toMatchObject([{ key: "zzz", hits: 20 }]);
    });

    it("через сервис: незнакомые ключи копятся и вместе с известными, и сами по себе", async () => {
      await service.onSession(launch(`src-k${run}_zzz-1`));
      await service.onSession(launch("yyy-1_zzz-2"));

      expect((await keysTable()).map((row) => [row.key, row.hits])).toEqual([
        ["yyy", 1],
        ["zzz", 2],
      ]);
      expect(await autoLinks()).toHaveLength(1);
    });
  });

  describe("запуски по источнику", () => {
    it("три аккаунта запустили игру до заведения источника и один после — directLaunches 4, launches 0", async () => {
      const key = `src-d${run}_cmp-oct`;
      for (let index = 0; index < 3; index++) await taggedSession(await account(), key, key);

      await service.onSession(launch(key));
      await taggedSession(await account(), key, key);

      const stats = (await links.list(500)).find((row) => row.autoKey === key);
      expect(stats).toMatchObject({ auto: true, partnerTag: null, title: null, hiddenAt: null, clicks: 0, launches: 0, directLaunches: 4 });
    });

    it("тот же игрок дважды считается одним; запуск по другому набору — не этого источника", async () => {
      const key = `src-e${run}_cmp-oct`;
      await service.onSession(launch(key));
      const me = await account();
      await taggedSession(me, key, key);
      await taggedSession(me, key, key);
      await taggedSession(await account(), `src-f${run}_cmp-oct`, `src-f${run}_cmp-oct`);

      const stats = (await links.list(500)).find((row) => row.autoKey === key);
      expect(stats?.directLaunches).toBe(1);
    });

    it("прямые запуски ссылки команды по l-<код> считаются как раньше", async () => {
      const code = newLinkCode();
      await links.create({ code, platform: "telegram", campaign: "launch", source: null, medium: null, note: null, createdBy: null, network: null, registrationOn: "first_run" });
      const me = await account();
      await sessions.record({
        sessionId: randomUUID(),
        accountId: me,
        platform: "telegram",
        place: "miniapp",
        startKind: "link",
        startParam: `l-${code}`,
        startRef: code,
        clientPlatform: null,
        clientVersion: null,
        deviceClass: "mobile",
        os: "android",
        ipPrefix: null,
        startedAt: new Date().toISOString(),
      });

      expect((await links.list(500)).find((row) => row.code === code)).toMatchObject({ auto: false, directLaunches: 1, launches: 0 });
    });

    it("скрытый источник в списке остаётся: фильтр — в панели", async () => {
      const key = `src-g${run}`;
      await service.onSession(launch(key));
      await prisma.$executeRaw`UPDATE link SET hidden_at = now() WHERE auto_key = ${key}`;

      const stats = (await links.list(500)).find((row) => row.autoKey === key);
      expect(stats?.hiddenAt).toBeInstanceOf(Date);
    });
  });

  describe("вход из бота и из Mini App", () => {
    it("`/start` в боте и открытие Mini App по одной ссылке с метками дают один источник и два запуска", async () => {
      const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, DATABASE_URL } as NodeJS.ProcessEnv);
      const hooks = new AuthHooks();
      const recorder = new SessionRecorder(config, hooks, sessions, { claim: async () => true }, null, service);
      recorder.onModuleInit();
      const auth = new AuthService(config, accounts, new MemoryRefreshStore(), hooks, launchVerifiersFor(config));
      const key = `src-b${run}_cmp-oct`;
      const botUser = String(Math.floor(Math.random() * 1e12));
      const appUser = Math.floor(Math.random() * 1e9) + 1_000_000_000;

      await auth.enterChannel({ platform: "telegram", platformUserId: botUser, displayName: "Из бота", username: null, startParam: `CMP-oct_SRC-B${run.toUpperCase()}` });
      await auth.loginWithLaunch(
        "telegram",
        signInitData(
          { auth_date: String(Math.floor(Date.now() / 1000) - 60), user: JSON.stringify({ id: appUser, first_name: "Из приложения" }), start_param: key },
          AUTH_ENV.TELEGRAM_BOT_TOKEN,
        ),
        { ip: "203.0.113.57", userAgent: null, client: null, reason: "launch" },
      );

      // Слушатели входа работают после ответа игроку: ждём записи, а не ответа.
      await vi.waitFor(async () => expect((await links.list(500)).find((row) => row.autoKey === key)?.directLaunches).toBe(2), { timeout: 10_000, interval: 100 });
      expect((await autoLinks()).filter((row) => row.autoKey === key)).toHaveLength(1);
      expect(await prisma.accountSession.count({ where: { startKind: "tagged", startRef: key } })).toBe(2);
    });
  });
});
