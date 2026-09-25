import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaSessionsRepository } from "../src/modules/attribution/sessions.repository.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { funnelReport } from "../src/modules/funnel/funnel-report.js";
import { PrismaFunnelRepository } from "../src/modules/funnel/funnel.repository.js";

/**
 * Вехи воронки на живом Postgres (docs/17-testing-strategy.md
 * §4.2; адрес — TEST_DATABASE_URL, без него пропуск).
 *
 * Память этого не покажет: вехи ставит одна вставка с `ON CONFLICT`, в
 * которой `SET` видит строку до обновления, — на этом держатся счётчик
 * забегов и возвраты по московским суткам.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const HOUR = 3_600_000;
/** 25 сентября 2026, 12:00 по Москве */
const T0 = Date.UTC(2026, 8, 25, 9, 0, 0);

describe.skipIf(DATABASE_URL === "")("вехи воронки на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let funnel: PrismaFunnelRepository;

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(710_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Путник", username: null },
      Date.now(),
    );
    return created.accountId;
  }

  async function row(accountId: string) {
    return await prisma.accountFunnel.findUniqueOrThrow({ where: { accountId } });
  }

  beforeAll(() => {
    prisma = createPrisma(loadAppConfig({ DATABASE_URL }));
    accounts = new PrismaAccountRepository(prisma);
    funnel = new PrismaFunnelRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("веха — дата первого раза: повтор ничего не двигает", async () => {
    const id = await account();
    await funnel.entered(id, new Date(T0));
    await funnel.entered(id, new Date(T0 + HOUR));
    await funnel.firstRunStarted(id, new Date(T0 + 2 * HOUR));
    await funnel.firstRunStarted(id, new Date(T0 + 3 * HOUR));

    const saved = await row(id);
    expect(saved.enteredAt).toEqual(new Date(T0));
    expect(saved.firstRunStartedAt).toEqual(new Date(T0 + 2 * HOUR));
  });

  it("второй и пятый забег — по счётчику записанных, первый — дата первого", async () => {
    const id = await account();
    for (let run = 1; run <= 6; run++) await funnel.runRecorded(id, new Date(T0 + run * HOUR));

    const saved = await row(id);
    expect(saved.runsRecorded).toBe(6);
    expect(saved.firstRunFinishedAt).toEqual(new Date(T0 + HOUR));
    expect(saved.runs2At).toEqual(new Date(T0 + 2 * HOUR));
    expect(saved.runs5At).toEqual(new Date(T0 + 5 * HOUR));
  });

  it("параллельные записи забегов не теряют ни одного", async () => {
    const id = await account();
    await Promise.all(Array.from({ length: 10 }, (_, index) => funnel.runRecorded(id, new Date(T0 + index * 1000))));
    expect((await row(id)).runsRecorded).toBe(10);
  });

  it("возврат считается по московским суткам от первого открытия", async () => {
    const id = await account();
    // Первое открытие — 23:30 по Москве 25-го; через час по Москве уже 26-е: это D1,
    // хотя по UTC прошёл всего час и сутки те же.
    const late = Date.UTC(2026, 8, 25, 20, 30, 0);
    await funnel.appOpened(id, new Date(late));
    await funnel.appOpened(id, new Date(late + 20 * 60_000));
    expect((await row(id)).returnedD1At).toBeNull();

    await funnel.appOpened(id, new Date(late + HOUR));
    const d1 = await row(id);
    expect(d1.appOpenedAt).toEqual(new Date(late));
    expect(d1.returnedD1At).toEqual(new Date(late + HOUR));
    expect(d1.returnedD7At).toBeNull();

    await funnel.appOpened(id, new Date(late + 6 * 24 * HOUR));
    expect((await row(id)).returnedD7At).toBeNull();
    await funnel.appOpened(id, new Date(late + 6 * 24 * HOUR + 2 * HOUR));
    const d7 = await row(id);
    expect(d7.returnedD7At).toEqual(new Date(late + 6 * 24 * HOUR + 2 * HOUR));
    expect(d7.returnedD1At).toEqual(new Date(late + HOUR));
  });

  it("отчёт считает вехи по источнику первого касания", async () => {
    const sessions = new PrismaSessionsRepository(prisma);
    const campaign = `C${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const ids = [await account(), await account(), await account()];
    for (const id of ids) {
      await sessions.record({
        sessionId: randomUUID(),
        accountId: id,
        platform: "telegram",
        place: "channel",
        startKind: "click",
        startParam: `c-${campaign}`,
        startRef: campaign,
        clientPlatform: null,
        clientVersion: null,
        deviceClass: "unknown",
        os: "unknown",
        ipPrefix: null,
        startedAt: new Date(T0).toISOString(),
      });
      await funnel.entered(id, new Date(T0));
    }
    await funnel.appOpened(ids[0]!, new Date(T0 + HOUR));
    await funnel.appOpened(ids[1]!, new Date(T0 + HOUR));
    await funnel.runRecorded(ids[0]!, new Date(T0 + 2 * HOUR));

    const report = await funnelReport(prisma, new Date(T0 - HOUR), new Date(T0 + 24 * HOUR));
    expect(report.find((line) => line.startRef === campaign)).toMatchObject({
      platform: "telegram",
      startKind: "click",
      accounts: 3,
      entered: 3,
      appOpened: 2,
      firstRunFinished: 1,
    });
  });
});
