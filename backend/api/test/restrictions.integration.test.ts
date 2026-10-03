import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaRestrictionsRepository, REPLACED_COMMENT, type NewRestriction } from "../src/modules/restrictions/restrictions.repository.js";

/**
 * Ограничения на живом Postgres (docs/17-testing-strategy.md §4.2; адрес —
 * TEST_DATABASE_URL, без него пропуск): одно действующее ограничение вида на
 * игрока и под гонкой двух модераторов, снятое второй раз не снимается,
 * задача по сроку видит только несведённые, а база не примет молчаливую
 * блокировку и срок раньше начала.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const NOW = new Date(Date.UTC(2026, 9, 1, 12));
const DAY = 86_400_000;

describe.skipIf(DATABASE_URL === "")("ограничения на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let repository: PrismaRestrictionsRepository;

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL, max: 10, connectionTimeoutMillis: 30_000 }) });
    accounts = new PrismaAccountRepository(prisma);
    repository = new PrismaRestrictionsRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(930_000_000 + Math.floor(Math.random() * 60_000_000)), displayName: "Ограничения", username: null },
      Date.now(),
    );
    return created.accountId;
  }

  const row = (accountId: string, imposedBy: string, patch: Partial<NewRestriction> = {}): NewRestriction => ({
    accountId,
    kind: "promo_codes",
    startsAt: NOW,
    endsAt: new Date(NOW.getTime() + DAY),
    reason: "promo_abuse",
    comment: null,
    notify: true,
    imposedBy,
    ...patch,
  });

  it("новое того же вида снимает действующее; разом от двух модераторов — действующее одно", async () => {
    const [target, first, second] = [await account(), await account(), await account()];
    await repository.impose([row(target, first)], NOW);
    const later = new Date(NOW.getTime() + 60_000);
    await Promise.all([repository.impose([row(target, first, { startsAt: later })], later), repository.impose([row(target, second, { startsAt: later })], later)]);

    const active = await repository.active(target, later);
    expect(active).toHaveLength(1);
    const history = await repository.byAccount(target, 10);
    expect(history).toHaveLength(3);
    expect(history.filter((item) => item.liftComment === REPLACED_COMMENT)).toHaveLength(2);
  });

  it("снять можно только действующее и только однажды; истёкшее не снимается", async () => {
    const [target, moderator] = [await account(), await account()];
    const { created } = await repository.impose([row(target, moderator), row(target, moderator, { kind: "ad_rewards", endsAt: new Date(NOW.getTime() + 60_000) })], NOW);
    const [promo, ads] = created;
    const lifted = await Promise.all([repository.lift(promo?.restrictionId ?? "", moderator, "ошибка", NOW), repository.lift(promo?.restrictionId ?? "", moderator, "ещё раз", NOW)]);
    const winners = lifted.filter((item) => item !== null);
    expect(winners).toHaveLength(1);
    // Кто успел первым — решает база; проигравший не перепишет причину победившего.
    expect((await repository.byId(promo?.restrictionId ?? ""))?.liftComment).toBe(winners[0]?.liftComment);
    expect(await repository.lift(ads?.restrictionId ?? "", moderator, "поздно", new Date(NOW.getTime() + 120_000))).toBeNull();
  });

  it("задача по сроку видит снятые и истёкшие без отметки — и не видит их после неё", async () => {
    const [target, moderator] = [await account(), await account()];
    const at = new Date(Date.UTC(2031, 0, 1));
    const { created } = await repository.impose(
      [row(target, moderator, { kind: "all", startsAt: at, endsAt: new Date(at.getTime() + DAY) }), row(target, moderator, { kind: "friend_gifts", startsAt: at, endsAt: null })],
      at,
    );
    const ids = created.map((item) => item.restrictionId);
    const later = new Date(at.getTime() + DAY + 1);
    const due = (await repository.unsettled(later, 10_000)).filter((item) => ids.includes(item.restrictionId));
    expect(due.map((item) => item.kind)).toEqual(["all"]);
    await repository.markSettled(due.map((item) => item.restrictionId), later);
    expect((await repository.unsettled(later, 10_000)).filter((item) => ids.includes(item.restrictionId))).toEqual([]);
  });

  it("база держит форму: блокировка — не молча, срок после начала, снятие — с причиной; удалённый аккаунт уносит свои строки", async () => {
    const [target, moderator] = [await account(), await account()];
    await expect(repository.impose([row(target, moderator, { kind: "all", notify: false })], NOW)).rejects.toThrow();
    await expect(repository.impose([row(target, moderator, { endsAt: new Date(NOW.getTime() - 1) })], NOW)).rejects.toThrow();
    await expect(repository.impose([row(target, moderator, { kind: "Bad Kind" })], NOW)).rejects.toThrow();
    const { created } = await repository.impose([row(target, moderator)], NOW);
    await expect(prisma.$executeRaw`UPDATE account_restriction SET lifted_at = now() WHERE restriction_id = ${created[0]?.restrictionId ?? ""}::uuid`).rejects.toThrow();

    await prisma.$executeRaw`DELETE FROM account WHERE account_id = ${target}::uuid`;
    expect(await repository.byAccount(target, 10)).toEqual([]);
  });
});
