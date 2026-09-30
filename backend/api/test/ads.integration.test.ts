import { randomBytes, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import type { AdSuccess } from "../src/modules/ads/ads-rules.js";
import { PrismaAdsRepository, type AdBlockRow } from "../src/modules/ads/ads.repository.js";
import { claimVerdict } from "../src/modules/ads/ads.service.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";

/**
 * Реклама на живом Postgres (docs/17-testing-strategy.md §4.2; адрес —
 * TEST_DATABASE_URL, без него пропуск): начало суток считает база по Москве,
 * клиент засчитывает только показ, одну сессию забирают однажды, две
 * сессии разом не проскакивают кулдаун, база не примет забор без выполнения.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const MINUTE = 60_000;
/** среда, 30.09.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 8, 30, 9));
const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * MINUTE);

describe.skipIf(DATABASE_URL === "")("реклама на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let repository: PrismaAdsRepository;
  /** свои сети теста: общие из миграции выключены, а чужие тесты их не трогают */
  const network = `it_${randomBytes(4).toString("hex")}`;
  const blocks: Partial<Record<AdSuccess, AdBlockRow>> = {};

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(930_000_000 + Math.floor(Math.random() * 30_000_000)), displayName: "Реклама", username: null },
      Date.now(),
    );
    return created.accountId;
  }

  function blockOf(success: AdSuccess): AdBlockRow {
    const found = blocks[success];
    if (found === undefined) throw new Error(`нет блока ${success}`);
    return found;
  }

  async function session(accountId: string, success: AdSuccess = "view", createdAt = NOON, place: "wheel_spin" | "task" = "wheel_spin"): Promise<string> {
    const sessionId = randomBytes(12).toString("base64url");
    await repository.createSession({ sessionId, accountId, place, block: { ...blockOf(success), place }, createdAt, expiresAt: at(createdAt, 30) });
    return sessionId;
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 10, connectionTimeoutMillis: 30_000 }) });
    accounts = new PrismaAccountRepository(prisma);
    repository = new PrismaAdsRepository(prisma);
    await prisma.$executeRaw`INSERT INTO ad_network (network_key, name, active, priority, updated_at) VALUES (${network}, 'Проверка', true, 5, now())`;
    for (const success of ["view", "click", "cpa"] as const) {
      const blockId = randomUUID();
      await prisma.$executeRaw`
        INSERT INTO ad_block (block_id, network_key, place, external_id, success, platforms, devices, created_at, updated_at)
        VALUES (${blockId}::uuid, ${network}, 'wheel_spin', ${`ext-${success}`}, ${success}::"AdSuccess", ARRAY['telegram']::"Platform"[], ARRAY['android']::varchar(16)[], now(), now())`;
      blocks[success] = { blockId, networkKey: network, place: "wheel_spin", externalId: `ext-${success}`, success, priority: 5, platforms: ["telegram"], devices: ["android"] };
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("сети из миграции выключены; в работе — только включённые блоки включённых сетей, с приоритетом сети", async () => {
    const seeded = await prisma.$queryRaw<{ network_key: string; active: boolean }[]>`
      SELECT network_key, active FROM ad_network WHERE network_key IN ('adsgram', 'adsonar', 'richads', 'taddy') ORDER BY priority`;
    expect(seeded).toEqual(["adsgram", "adsonar", "richads", "taddy"].map((key) => ({ network_key: key, active: false })));

    const mine = (await repository.activeBlocks()).filter((block) => block.networkKey === network);
    expect(mine).toHaveLength(3);
    expect(mine.find((block) => block.success === "view")).toEqual(blockOf("view"));

    await prisma.$executeRaw`UPDATE ad_block SET active = false WHERE block_id = ${blockOf("cpa").blockId}::uuid`;
    expect((await repository.activeBlocks()).filter((block) => block.networkKey === network)).toHaveLength(2);
    await prisma.$executeRaw`UPDATE ad_block SET active = true WHERE block_id = ${blockOf("cpa").blockId}::uuid`;
  });

  it("сутки истории — московские: 23:59 и 00:01 — разные сутки, окно — с начала вчерашних, забранные первыми", async () => {
    const me = await account();
    const lateNight = new Date(Date.UTC(2026, 8, 30, 20, 59));
    const earlyMorning = new Date(Date.UTC(2026, 8, 30, 21, 1));
    expect((await repository.history(me, "wheel_spin", lateNight)).dayStart).toEqual(new Date(Date.UTC(2026, 8, 29, 21)));
    expect((await repository.history(me, "wheel_spin", earlyMorning)).dayStart).toEqual(new Date(Date.UTC(2026, 8, 30, 21)));

    const old = await session(me, "view", new Date(Date.UTC(2026, 8, 28, 20, 59)));
    const claimed = await session(me, "view", at(NOON, -10));
    const fresh = await session(me, "view", NOON);
    await repository.report(claimed, me, { kind: "completed" }, at(NOON, -9));
    await repository.claim(claimed, me, "wheel_spin", at(NOON, -9), () => ({ kind: "allow" }));

    const history = await repository.history(me, "wheel_spin", NOON);
    expect(history.sessions.map((row) => row.sessionId)).toEqual([claimed, fresh]);
    expect(history.sessions.map((row) => row.sessionId)).not.toContain(old);
    expect((await repository.history(me, "task", NOON)).sessions).toEqual([]);
  });

  it("воронка: показ и досмотр — метками, клик не выполняет, отказ закрывает; чужая и истёкшая шагов не принимают", async () => {
    const me = await account();
    const stranger = await account();
    const view = await session(me);
    expect(await repository.report(view, me, { kind: "shown" }, at(NOON, 1))).toBe(true);
    expect(await repository.report(view, stranger, { kind: "completed" }, at(NOON, 2))).toBe(false);
    expect(await repository.report(view, me, { kind: "completed" }, at(NOON, 2))).toBe(true);
    expect(await repository.report(view, me, { kind: "failed", reason: "late" }, at(NOON, 3))).toBe(false);

    const click = await session(me, "click");
    expect(await repository.report(click, me, { kind: "clicked" }, at(NOON, 1))).toBe(true);
    expect(await repository.report(click, me, { kind: "completed" }, at(NOON, 1))).toBe(false);
    expect(await repository.report(click, me, { kind: "failed", reason: "sdk_error" }, at(NOON, 2))).toBe(true);
    expect(await repository.report(click, me, { kind: "shown" }, at(NOON, 3))).toBe(false);

    const expired = await session(me);
    expect(await repository.report(expired, me, { kind: "completed" }, at(NOON, 30))).toBe(false);

    const [row] = await prisma.$queryRaw<{ status: string; shown_at: Date; completed_at: Date }[]>`
      SELECT status::text, shown_at, completed_at FROM ad_session WHERE session_id = ${view}`;
    expect(row).toEqual({ status: "completed", shown_at: at(NOON, 1), completed_at: at(NOON, 2) });
    const [failed] = await prisma.$queryRaw<{ status: string; clicked_at: Date; fail_reason: string }[]>`
      SELECT status::text, clicked_at, fail_reason FROM ad_session WHERE session_id = ${click}`;
    expect(failed).toEqual({ status: "failed", clicked_at: at(NOON, 1), fail_reason: "sdk_error" });
  });

  it("одну сессию шесть раз разом забирают однажды — остальным она отдаётся повтором", async () => {
    const me = await account();
    const sessionId = await session(me);
    await repository.report(sessionId, me, { kind: "completed" }, at(NOON, 1));
    const verdict = (row: Parameters<typeof claimVerdict>[0], history: Parameters<typeof claimVerdict>[1]) => claimVerdict(row, history, at(NOON, 1));
    const results = await Promise.all(Array.from({ length: 6 }, () => repository.claim(sessionId, me, "wheel_spin", at(NOON, 1), verdict)));
    expect(results.filter((result) => result.status === "claimed" && !result.repeat)).toHaveLength(1);
    expect(results.every((result) => result.status === "claimed")).toBe(true);
  });

  it("две досмотренные сессии разом не проскакивают кулдаун места", async () => {
    const me = await account();
    const sessions = [await session(me), await session(me), await session(me)];
    for (const sessionId of sessions) await repository.report(sessionId, me, { kind: "completed" }, at(NOON, 1));
    const verdict = (row: Parameters<typeof claimVerdict>[0], history: Parameters<typeof claimVerdict>[1]) => claimVerdict(row, history, at(NOON, 1));
    const results = await Promise.all(sessions.map((sessionId) => repository.claim(sessionId, me, "wheel_spin", at(NOON, 1), verdict)));
    expect(results.filter((result) => result.status === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result.status === "cooldown")).toEqual([
      { status: "cooldown", retryAt: at(NOON, 121) },
      { status: "cooldown", retryAt: at(NOON, 121) },
    ]);
  });

  it("не выполненное не забирается — ни через сервис, ни мимо него: база не примет забор без выполнения", async () => {
    const me = await account();
    const sessionId = await session(me);
    expect(await repository.claim(sessionId, me, "wheel_spin", NOON, (row, history) => claimVerdict(row, history, NOON))).toEqual({ status: "not_completed" });
    expect(await repository.claim(sessionId, me, "task", NOON, () => ({ kind: "allow" }))).toEqual({ status: "not_completed" });
    await expect(prisma.$executeRaw`UPDATE ad_session SET claimed_at = now() WHERE session_id = ${sessionId}`).rejects.toThrow();
    await expect(prisma.$executeRaw`
      INSERT INTO ad_session (session_id, account_id, place, block_id, network_key, success, created_at, expires_at)
      VALUES ('it-bad-expiry', ${me}::uuid, 'wheel_spin', ${blockOf("view").blockId}::uuid, ${network}, 'view', now(), now() - interval '1 minute')`).rejects.toThrow();
    await expect(prisma.$executeRaw`
      INSERT INTO ad_block (block_id, network_key, place, external_id, devices, created_at, updated_at)
      VALUES (${randomUUID()}::uuid, ${network}, 'task', 'ext-tv', ARRAY['tv']::varchar(16)[], now(), now())`).rejects.toThrow();
  });

  it("удалённый аккаунт уносит свои сессии показа", async () => {
    const me = await account();
    await session(me);
    await prisma.$executeRaw`DELETE FROM account WHERE account_id = ${me}::uuid`;
    const [left] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM ad_session WHERE account_id = ${me}::uuid`;
    expect(Number(left?.n)).toBe(0);
  });
});
