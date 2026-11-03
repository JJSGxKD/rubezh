import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaSessionsRepository } from "../src/modules/attribution/sessions.repository.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaAutoSourcesRepository, UNKNOWN_KEYS_MAX } from "../src/modules/links/auto-sources.repository.js";
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
    expect(stats).toMatchObject({ clicks: 2, clicks30d: 2, launches: 2, directLaunches: 1, devices: { mobile: 2, desktop: 0, web: 0, unknown: 0 } });

    // Тот же игрок по прямой ссылке ещё раз — всё ещё один; чужой код — не этой ссылки.
    await launch(sessions, direct, "link", code);
    await launch(sessions, await newAccount("Чужой"), "link", newLinkCode());
    expect((await links.list(500)).find((row) => row.code === code)).toMatchObject({ launches: 2, directLaunches: 1 });
  });

  it("проверки доступности не считаются, устройства — отдельно; клики без Referer считаются", async () => {
    const code = newLinkCode();
    await links.create({ code, platform: "telegram", campaign: "checks", source: null, medium: null, note: null, createdBy: null, network: null, registrationOn: "first_run" });
    const utm = { source: null, medium: null, campaign: null, content: null, term: null };
    const click = (refererHost: string | null, deviceClass: string | null) =>
      links.recordClick({ clickId: newClickId(), linkCode: code, at: new Date(), utm, refererHost, deviceClass, ipPrefix: null, language: null, networkParams: null });
    await click("t.me", "mobile");
    await click(null, "mobile");
    await click(null, "unknown");
    await click(null, null);
    // Клик проверки, записанный до отсечения на входе: в базе остаётся, в цифры не идёт.
    await click("check-host.net", "unknown");
    // Старая запись с портом в хосте Referer: отсекается по хосту без порта.
    await click("check-host.net:8443", "mobile");

    const stats = (await links.list(500)).find((row) => row.code === code);
    expect(stats).toMatchObject({ clicks: 4, clicks30d: 4, devices: { mobile: 2, desktop: 0, web: 0, unknown: 2 } });
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
  describe("автоисточники: название, скрытие, сводка ключей (T-0180)", () => {
    const run = randomUUID().replaceAll("-", "").slice(0, 6);
    const autoSources = () => new PrismaAutoSourcesRepository(prisma);

    async function autoSource(tag: string): Promise<string> {
      const autoKey = `src-t${run}${tag}`;
      await autoSources().ensure({ autoKey, source: `t${run}${tag}`, campaign: "oct", medium: null, partnerTag: null, platform: "telegram", now: new Date(), cap: 1_000_000 });
      const row = await prisma.link.findUnique({ where: { autoKey }, select: { code: true } });
      if (row === null) throw new Error("автоисточник не заведён");
      return row.code;
    }

    afterAll(async () => {
      await prisma.link.deleteMany({ where: { autoKey: { startsWith: `src-t${run}` } } });
      await prisma.startParamKey.deleteMany({ where: { key: { startsWith: `t${run}` } } });
    });

    it("setDisplay: название и скрытие только у автоисточника; ручная ссылка — null, ничего не меняется", async () => {
      const code = await autoSource("a");
      const now = new Date();
      expect(await links.setDisplay(code, { title: "Посев в Канале N" }, now)).toMatchObject({ code, title: "Посев в Канале N", hiddenAt: null, campaign: "oct", source: `t${run}a` });
      expect(await links.setDisplay(code, { hidden: true }, now)).toMatchObject({ title: "Посев в Канале N", hiddenAt: now });
      // Скрытие название не трогает, а название — скрытие.
      expect(await links.setDisplay(code, { title: null }, now)).toMatchObject({ title: null, hiddenAt: now });
      expect(await links.setDisplay(code, { hidden: false }, now)).toMatchObject({ hiddenAt: null });

      const manual = newLinkCode();
      await links.create({ code: manual, platform: "telegram", campaign: "manual", source: null, medium: null, note: null, createdBy: null, network: null, registrationOn: "first_run" });
      expect(await links.setDisplay(manual, { title: "Имя" }, now)).toBeNull();
      expect(await links.setDisplay(newLinkCode(), { hidden: true }, now)).toBeNull();
      expect(await links.byCode(manual)).toMatchObject({ title: null, hiddenAt: null });
    });

    it("скрытый источник остаётся в list со счётом запусков и hiddenAt; повторный ensure его не заводит заново", async () => {
      const code = await autoSource("b");
      const accounts = new PrismaAccountRepository(prisma);
      const account = await accounts.upsert({ platform: "telegram", platformUserId: String(950_000_000 + Math.floor(Math.random() * 9_000_000)), displayName: "Пришёл по метке", username: null, photoUrl: null }, Date.now());
      await new PrismaSessionsRepository(prisma).record({
        sessionId: randomUUID(),
        accountId: account.accountId,
        platform: "telegram",
        place: "miniapp",
        startKind: "tagged",
        startParam: `src-t${run}b`,
        startRef: `src-t${run}b`,
        clientPlatform: "android",
        clientVersion: "8.0",
        deviceClass: "mobile",
        os: "android",
        ipPrefix: "198.51.100.0/24",
        startedAt: new Date().toISOString(),
      });

      const hiddenAt = new Date();
      await links.setDisplay(code, { hidden: true }, hiddenAt);
      expect((await links.list(500)).find((row) => row.code === code)).toMatchObject({ auto: true, hiddenAt, directLaunches: 1 });

      const outcome = await autoSources().ensure({ autoKey: `src-t${run}b`, source: `t${run}b`, campaign: "oct", medium: null, partnerTag: null, platform: "telegram", now: new Date(), cap: 1_000_000 });
      expect(outcome).toBe("existing");
      expect(await links.byCode(code)).toMatchObject({ hiddenAt });
    });

    it("unknownKeys: по убыванию последнего раза и не больше потолка", async () => {
      const at = (offset: number) => new Date(Date.UTC(2026, 9, 20) + offset);
      await prisma.startParamKey.createMany({
        data: [
          { key: `t${run}old`, hits: 3, firstAt: at(0), lastAt: at(1_000) },
          { key: `t${run}new`, hits: 14, firstAt: at(0), lastAt: at(9_000_000_000) },
          { key: `t${run}mid`, hits: 1, firstAt: at(0), lastAt: at(5_000_000) },
        ],
      });
      const rows = await autoSources().unknownKeys();
      expect(rows.length).toBeLessThanOrEqual(UNKNOWN_KEYS_MAX);
      expect(rows.map((row) => row.key).filter((key) => key.startsWith(`t${run}`))).toEqual([`t${run}new`, `t${run}mid`, `t${run}old`]);
      expect(rows.find((row) => row.key === `t${run}new`)).toMatchObject({ hits: 14, firstAt: at(0), lastAt: at(9_000_000_000) });
      // По убыванию «последнего раза» вся выдача, а не только наши строки.
      expect(rows.map((row) => row.lastAt.getTime())).toEqual([...rows.map((row) => row.lastAt.getTime())].sort((a, b) => b - a));
      expect(await autoSources().unknownKeys(2)).toHaveLength(2);
    });
  });
});
