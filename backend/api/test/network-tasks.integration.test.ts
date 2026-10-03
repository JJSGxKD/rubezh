import { randomBytes, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAdsRepository, type AdBlockRow, type NewAdSession } from "../src/modules/ads/ads.repository.js";
import { claimVerdict } from "../src/modules/ads/ads.service.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { admitsTask } from "../src/modules/tasks/network-task-rules.js";
import { PrismaNetworkTasksRepository } from "../src/modules/tasks/network-tasks.repository.js";

/**
 * Задания рекламных сетей на живом Postgres (docs/35-stage4-plan.md WP13,
 * часть 6; адрес — TEST_DATABASE_URL, без него пропуск): открытая сессия
 * сети одна и под гонкой, подтверждение выполняет открытую и отдаёт
 * выполненную без забора снова, а забранную — нет; строка сети из
 * миграции на месте, и база держит пределы панели.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const MINUTE = 60_000;
/** 03.10.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 9, 3, 9));
const at = (minutes: number) => new Date(NOON.getTime() + minutes * MINUTE);

describe.skipIf(DATABASE_URL === "")("задания сетей на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let ads: PrismaAdsRepository;
  let rows: PrismaNetworkTasksRepository;
  const network = `it_${randomBytes(4).toString("hex")}`;
  let block: AdBlockRow;

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(960_000_000 + Math.floor(Math.random() * 30_000_000)), displayName: "Задания сетей", username: null },
      Date.now(),
    );
    return created.accountId;
  }

  function fresh(accountId: string, createdAt: Date): NewAdSession {
    return { sessionId: randomBytes(12).toString("base64url"), accountId, place: "task", block, creative: null, createdAt, expiresAt: new Date(createdAt.getTime() + 24 * 60 * MINUTE) };
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 10, connectionTimeoutMillis: 30_000 }) });
    accounts = new PrismaAccountRepository(prisma);
    ads = new PrismaAdsRepository(prisma);
    rows = new PrismaNetworkTasksRepository(prisma);
    await prisma.$executeRaw`INSERT INTO ad_network (network_key, name, active, priority, updated_at) VALUES (${network}, 'Проверка', true, 5, now())`;
    const blockId = randomUUID();
    await prisma.$executeRaw`
      INSERT INTO ad_block (block_id, network_key, place, external_id, success, created_at, updated_at)
      VALUES (${blockId}::uuid, ${network}, 'task', 'task-77', 'cpa', now(), now())`;
    block = { blockId, networkKey: network, place: "task", externalId: "task-77", success: "cpa", priority: 5, networkKeys: {}, platforms: [], devices: [] };
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("строка AdsGram из миграции — рабочие числа; база не примет потолок и паузу вне пределов и чужую сеть", async () => {
    const seeded = (await rows.all()).find((row) => row.networkKey === "adsgram");
    expect(seeded).toMatchObject({ active: true, dailyCap: 5, pauseMin: 30, coins: 100, gems: 0, shards: 0, updatedBy: null });
    await expect(prisma.$executeRaw`INSERT INTO network_task (network_key, daily_cap, pause_min, coins, updated_at) VALUES (${network}, 3, 4, 10, now())`).rejects.toThrow();
    await expect(prisma.$executeRaw`INSERT INTO network_task (network_key, daily_cap, pause_min, coins, updated_at) VALUES (${network}, 0, 30, 10, now())`).rejects.toThrow();
    await expect(prisma.$executeRaw`INSERT INTO network_task (network_key, daily_cap, pause_min, coins, updated_at) VALUES (${network}, 3, 30, 0, now())`).rejects.toThrow();
    await expect(prisma.$executeRaw`INSERT INTO network_task (network_key, daily_cap, pause_min, coins, updated_at) VALUES ('no_such_net', 3, 30, 10, now())`).rejects.toThrow();

    await prisma.$executeRaw`INSERT INTO network_task (network_key, daily_cap, pause_min, coins, updated_at) VALUES (${network}, 3, 30, 10, now())`;
    const actor = await account();
    expect(await rows.update({ networkKey: network, active: false, dailyCap: 7, pauseMin: 45, coins: 20, gems: 1, shards: 2 }, actor, NOON)).toBe(true);
    expect((await rows.all()).find((row) => row.networkKey === network)).toEqual({
      networkKey: network,
      active: false,
      dailyCap: 7,
      pauseMin: 45,
      coins: 20,
      gems: 1,
      shards: 2,
      updatedAt: NOON,
      updatedBy: actor,
    });
    expect(await rows.update({ networkKey: "richads", active: true, dailyCap: 1, pauseMin: 5, coins: 1, gems: 0, shards: 0 }, actor, NOON)).toBe(false);
  });

  it("десять экранов разом заводят одну сессию сети; потом она отдаётся снова", async () => {
    const me = await account();
    const outcomes = await Promise.all(Array.from({ length: 10 }, async () => await ads.openTask(me, network, NOON, () => fresh(me, NOON))));
    const ids = new Set(outcomes.map((outcome) => outcome?.session.sessionId));
    expect(ids.size).toBe(1);
    expect(outcomes.filter((outcome) => outcome?.created === true)).toHaveLength(1);
    const again = await ads.openTask(me, network, at(10), () => fresh(me, at(10)));
    expect(again).toMatchObject({ created: false, session: { sessionId: [...ids][0], place: "task", networkKey: network, success: "cpa", status: "pending" } });
  });

  it("новую сессию решает хозяин по истории — подтверждённые за сутки, и решает под блокировкой", async () => {
    const me = await account();
    const def = { dailyCap: 1, pauseMin: 30 };
    const first = await ads.openTask(me, network, NOON, (history) => (admitsTask(def, history, network, NOON) ? fresh(me, NOON) : null));
    expect(first?.created).toBe(true);
    expect(await ads.confirmTask(me, network, at(2))).toMatchObject({ repeat: false, session: { status: "completed", completedAt: at(2) } });
    // Потолок суток выбран: хозяин не пускает новую, открытой нет.
    expect(await ads.openTask(me, network, at(60), (history) => (admitsTask(def, history, network, at(60)) ? fresh(me, at(60)) : null))).toBeNull();
  });

  it("подтверждение: открытую — выполняет; выполненную без забора — отдаёт снова; забранную и истёкшую — нет", async () => {
    const me = await account();
    expect(await ads.confirmTask(me, network, NOON)).toBeNull();
    const opened = await ads.openTask(me, network, NOON, () => fresh(me, NOON));
    const sessionId = opened?.session.sessionId ?? "";
    expect(await ads.confirmTask(me, network, at(1))).toMatchObject({ repeat: false, session: { sessionId, status: "completed", shownAt: at(1) } });
    expect(await ads.confirmTask(me, network, at(2))).toMatchObject({ repeat: true, session: { sessionId, status: "completed", completedAt: at(1) } });

    const claimed = await ads.claim(sessionId, me, "task", at(3), (session, history) => claimVerdict(session, history, at(3)));
    expect(claimed).toMatchObject({ status: "claimed", repeat: false });
    expect(await ads.confirmTask(me, network, at(4))).toBeNull();

    const late = await ads.openTask(me, network, at(5), () => fresh(me, at(5)));
    expect(late?.created).toBe(true);
    expect(await ads.confirmTask(me, network, at(5 + 24 * 60 + 1))).toBeNull();
  });

  it("открытая — раньше выполненной без забора: подтверждение относится к новому заданию", async () => {
    const me = await account();
    const old = await ads.openTask(me, network, NOON, () => fresh(me, NOON));
    await ads.confirmTask(me, network, at(1));
    const next = await ads.openTask(me, network, at(40), () => fresh(me, at(40)));
    expect(next?.created).toBe(true);
    const confirmed = await ads.confirmTask(me, network, at(41));
    expect(confirmed).toMatchObject({ repeat: false, session: { sessionId: next?.session.sessionId } });
    expect(confirmed?.session.sessionId).not.toBe(old?.session.sessionId);
  });
});
