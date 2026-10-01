import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { batchCode, codeKey, type PromoCampaignRow } from "../src/modules/promo-codes/promo-code-rules.js";
import { PrismaPromoCodesRepository, type NewPromoCampaign, type PromoCodeDraft } from "../src/modules/promo-codes/promo-codes.repository.js";

/**
 * Промокоды на живом Postgres (docs/17-testing-strategy.md §4.2; адрес —
 * TEST_DATABASE_URL, без него пропуск): лимит кампании и последний код
 * пачки под одновременным вводом, повтор игрока, удаление кампании с
 * погашениями и правила, которые база держит и в обход сервиса.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date(Date.UTC(2026, 9, 2, 9));

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

describe.skipIf(DATABASE_URL === "")("промокоды на живом Postgres", () => {
  let prisma: PrismaClient;
  let repository: PrismaPromoCodesRepository;
  let accounts: PrismaAccountRepository;

  // Свой код на каждый тест: чужие кампании базы тестов не мешают.
  const uniqueCode = () => `T${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  const campaign = (patch: Partial<NewPromoCampaign> = {}): NewPromoCampaign => ({
    campaignId: randomUUID(),
    title: "Стрим",
    kind: "shared",
    reward: { coins: 500, gems: 0, shard_common: 0, shard_uncommon: 0 },
    message: null,
    maxRedemptions: null,
    startsAt: at(-HOUR),
    endsAt: at(DAY),
    newPlayersDays: null,
    platforms: [],
    note: null,
    createdBy: randomUUID(),
    createdAt: NOW,
    ...patch,
  });
  const shared = (display: string): PromoCodeDraft[] => [{ code: codeKey(display), display }];
  const player = async () => (await accounts.upsert({ platform: "telegram", platformUserId: String(Math.floor(Math.random() * 1e12)), displayName: "Игрок", username: null, photoUrl: null }, NOW.getTime())).accountId;

  async function created(row: NewPromoCampaign, codes: PromoCodeDraft[], refill: ((count: number) => PromoCodeDraft[]) | null = null): Promise<PromoCampaignRow> {
    const outcome = await repository.create(row, codes, refill);
    if (outcome.status !== "created") throw new Error(`код занят: ${outcome.display}`);
    return outcome.row;
  }

  beforeAll(() => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 12, connectionTimeoutMillis: 30_000 }) });
    repository = new PrismaPromoCodesRepository(prisma);
    accounts = new PrismaAccountRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("заведение и чтение: награда, площадки, бессрочность и первый код — как записали", async () => {
    const display = uniqueCode();
    const row = await created(campaign({ endsAt: null, platforms: ["telegram", "vk"], newPlayersDays: 7, message: "Привет!", reward: { coins: 0, gems: 15, shard_common: 3, shard_uncommon: 1 } }), shared(display));
    expect(row).toMatchObject({ kind: "shared", endsAt: null, platforms: ["telegram", "vk"], newPlayersDays: 7, message: "Привет!", redeemed: 0, codeSample: display, reward: { coins: 0, gems: 15, shard_common: 3, shard_uncommon: 1 } });
    expect(await repository.codeOwner(codeKey(display))).toEqual({ display, title: "Стрим" });
    expect((await repository.lookup(codeKey(display)))?.campaign.campaignId).toBe(row.campaignId);
    expect((await repository.list(500)).some((candidate) => candidate.campaignId === row.campaignId)).toBe(true);
  });

  it("занятый код общего кода — отказ без записи кампании", async () => {
    const display = uniqueCode();
    await created(campaign(), shared(display));
    const second = campaign({ title: "Другой" });
    expect(await repository.create(second, shared(display), null)).toEqual({ status: "taken", display, title: "Стрим" });
    expect(await repository.byId(second.campaignId)).toBeNull();
  });

  it("код пачки, совпавший с занятым, заменяется из запаса, и кампания заводится целиком", async () => {
    const taken = uniqueCode();
    await created(campaign(), shared(taken));
    const fresh = Array.from({ length: 3 }, () => ({ code: codeKey(uniqueCode()), display: uniqueCode() }));
    let refills = 0;
    const row = await created(campaign({ kind: "batch", maxRedemptions: 3 }), [{ code: codeKey(taken), display: taken }, ...fresh.slice(0, 2)], (count) => {
      refills += 1;
      return fresh.slice(2, 2 + count);
    });
    expect(refills).toBe(1);
    expect((await repository.codes(row.campaignId, 10)).map((code) => code.display).sort()).toEqual([fresh[0]?.display, fresh[1]?.display, fresh[2]?.display].sort());
  });

  it("лимит 3 и десять игроков разом — ровно три погашения, счётчик кампании — три", async () => {
    const display = uniqueCode();
    const row = await created(campaign({ maxRedemptions: 3 }), shared(display));
    const players = await Promise.all(Array.from({ length: 10 }, player));
    const outcomes = await Promise.all(players.map((accountId) => repository.redeem({ campaignId: row.campaignId, accountId, code: codeKey(display), batch: false, at: NOW })));
    expect(outcomes.filter((outcome) => outcome === "redeemed")).toHaveLength(3);
    expect(outcomes.filter((outcome) => outcome === "exhausted")).toHaveLength(7);
    expect((await repository.byId(row.campaignId))?.redeemed).toBe(3);
  });

  it("один игрок жмёт пять раз разом — одно погашение, остальным «уже»", async () => {
    const display = uniqueCode();
    const row = await created(campaign(), shared(display));
    const accountId = await player();
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => repository.redeem({ campaignId: row.campaignId, accountId, code: codeKey(display), batch: false, at: NOW })));
    expect(outcomes.filter((outcome) => outcome === "redeemed")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "already")).toHaveLength(4);
    expect(await repository.redemption(row.campaignId, accountId)).toEqual({ rewardedAt: null });
    await repository.markRewarded(row.campaignId, accountId, { coins: 500, gems: 0, shard_common: 0, shard_uncommon: 0 }, at(1_000));
    expect(await repository.redemption(row.campaignId, accountId)).toEqual({ rewardedAt: at(1_000) });
  });

  it("код пачки, введённый пятью игроками разом, достаётся одному; отказ не съедает лимит", async () => {
    const codes = [batchCode(uniqueCode().slice(0, 8), () => 1), batchCode(uniqueCode().slice(0, 8), () => 2)];
    const row = await created(campaign({ kind: "batch", maxRedemptions: 2 }), codes);
    const players = await Promise.all(Array.from({ length: 5 }, player));
    const first = codes[0]?.code ?? "";
    const outcomes = await Promise.all(players.map((accountId) => repository.redeem({ campaignId: row.campaignId, accountId, code: first, batch: true, at: NOW })));
    expect(outcomes.filter((outcome) => outcome === "redeemed")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "used")).toHaveLength(4);
    // Проигравшие гонку не записаны погашением и могут взять второй код.
    const loser = players[outcomes.indexOf("used")] ?? "";
    expect(await repository.redemption(row.campaignId, loser)).toBeNull();
    expect(await repository.redeem({ campaignId: row.campaignId, accountId: loser, code: codes[1]?.code ?? "", batch: true, at: NOW })).toBe("redeemed");
    expect((await repository.byId(row.campaignId))?.redeemed).toBe(2);
    expect((await repository.codes(row.campaignId, 10)).every((code) => code.redeemedAt !== null)).toBe(true);
  });

  it("правка под блокировкой, пауза, удаление: с погашениями — нельзя ни сервису, ни мимо него", async () => {
    const display = uniqueCode();
    const row = await created(campaign(), shared(display));
    const update = { title: "Новое имя", note: "для команды", message: null, reward: row.reward, startsAt: row.startsAt, endsAt: null, newPlayersDays: null, platforms: [], maxRedemptions: 50 };
    const updated = await repository.update(row.campaignId, update, at(HOUR), () => null);
    expect(updated).toMatchObject({ status: "updated", before: { title: "Стрим" }, after: { title: "Новое имя", note: "для команды", endsAt: null, maxRedemptions: 50 } });
    expect(await repository.update(row.campaignId, update, at(HOUR), () => "нельзя")).toEqual({ status: "invalid", message: "нельзя" });
    expect(await repository.update(randomUUID(), update, at(HOUR), () => null)).toEqual({ status: "missing" });

    expect((await repository.setPaused(row.campaignId, at(HOUR), at(HOUR)))?.pausedAt).toEqual(at(HOUR));
    expect((await repository.setPaused(row.campaignId, null, at(2 * HOUR)))?.pausedAt).toBeNull();

    await repository.redeem({ campaignId: row.campaignId, accountId: await player(), code: codeKey(display), batch: false, at: NOW });
    expect(await repository.remove(row.campaignId)).toEqual({ status: "used", redeemed: 1 });
    await expect(prisma.$executeRaw`DELETE FROM promo_campaign WHERE campaign_id = ${row.campaignId}::uuid`).rejects.toThrow();

    const unused = await created(campaign(), shared(uniqueCode()));
    expect(await repository.remove(unused.campaignId)).toMatchObject({ status: "removed" });
    expect(await repository.byId(unused.campaignId)).toBeNull();
    expect(await repository.remove(unused.campaignId)).toEqual({ status: "missing" });
  });

  it("активации по московским суткам: 23:30 по Москве и 00:30 — разные дни", async () => {
    const display = uniqueCode();
    const row = await created(campaign({ startsAt: at(-DAY) }), shared(display));
    // 20:30 UTC = 23:30 МСК 2 октября; 21:30 UTC = 00:30 МСК 3 октября.
    const late = new Date(Date.UTC(2026, 9, 2, 20, 30));
    const early = new Date(Date.UTC(2026, 9, 2, 21, 30));
    await repository.redeem({ campaignId: row.campaignId, accountId: await player(), code: codeKey(display), batch: false, at: late });
    await repository.redeem({ campaignId: row.campaignId, accountId: await player(), code: codeKey(display), batch: false, at: early });
    expect(await repository.daily(row.campaignId, at(-DAY))).toEqual([
      { day: "2026-10-02", count: 1 },
      { day: "2026-10-03", count: 1 },
    ]);
  });

  it("база сама не примет пачку без лимита, погашений сверх лимита и конец раньше начала", async () => {
    const insert = (fields: { kind: string; max: number | null; redeemed: number; ends: Date | null }) => prisma.$executeRaw`
      INSERT INTO promo_campaign (campaign_id, title, kind, reward, max_redemptions, redeemed, starts_at, ends_at, created_by, created_at, updated_at)
      VALUES (${randomUUID()}::uuid, 'x', ${fields.kind}, '{}'::jsonb, ${fields.max}, ${fields.redeemed}, ${NOW}, ${fields.ends}, ${randomUUID()}::uuid, ${NOW}, ${NOW})`;
    await expect(insert({ kind: "batch", max: null, redeemed: 0, ends: null })).rejects.toThrow();
    await expect(insert({ kind: "shared", max: 2, redeemed: 3, ends: null })).rejects.toThrow();
    await expect(insert({ kind: "shared", max: null, redeemed: 0, ends: at(-HOUR) })).rejects.toThrow();
    await expect(insert({ kind: "gift", max: null, redeemed: 0, ends: null })).rejects.toThrow();
  });
});
