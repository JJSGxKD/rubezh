import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaDailyStatsRepository } from "../src/modules/admin-notify/daily-stats.repository.js";
import { boardMark, markedAccountIds } from "../src/modules/restrictions/board-mark.js";

/**
 * Метка «Отдельная доска» на живом Postgres (T-0115). Окно — в 2020 году:
 * виды соседних тестов начинаются позже и в него не попадают, а база общая.
 * Без базы — пропуск.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const HOUR = 3_600_000;
const FROM = new Date("2020-03-10T00:00:00Z");
const TO = new Date("2020-03-11T00:00:00Z");
const at = (offset: number) => new Date(FROM.getTime() + offset);

describe.skipIf(DATABASE_URL === "")("метка «Отдельная доска» на живом Postgres", () => {
  let prisma: PrismaClient;
  const ids: Record<string, string> = {};

  async function account(name: string, createdAt: Date): Promise<string> {
    const accountId = randomUUID();
    ids[name] = accountId;
    await prisma.account.create({ data: { accountId, platform: "telegram", platformUserId: `bm-${accountId.slice(0, 8)}`, displayName: name, createdAt, lastSeenAt: createdAt } });
    return accountId;
  }

  async function restrict(accountId: string, patch: { kind?: string; startsAt: Date; endsAt?: Date | null; liftedAt?: Date | null; settledAt?: Date | null }): Promise<void> {
    await prisma.accountRestriction.create({
      data: { accountId, kind: patch.kind ?? "separate_board", startsAt: patch.startsAt, endsAt: patch.endsAt ?? null, liftedAt: patch.liftedAt ?? null, settledAt: patch.settledAt ?? null, liftComment: patch.liftedAt === undefined || patch.liftedAt === null ? null : "снято", reason: "other", notify: false },
    });
  }

  async function session(accountId: string, startedAt: Date): Promise<void> {
    await prisma.accountSession.create({ data: { sessionId: randomUUID(), accountId, platform: "telegram", place: "miniapp", startKind: "organic", deviceClass: "mobile", os: "android", startedAt } });
  }

  async function run(accountId: string, finishedAt: Date, cheats = false): Promise<void> {
    await prisma.run.create({
      data: { runId: randomUUID(), accountId, status: "finished", difficulty: "easy", startingWeaponId: "spark", contentHash: "h", startedAt: finishedAt, finishedAt, survivalSec: 120, cheats, outcome: "died" },
    });
  }

  beforeAll(async () => {
    prisma = createPrisma(loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv));
    const before = at(-9 * 24 * HOUR);
    // Вид снят до окна: ни аккаунт, ни его сессия и забег в метку не идут.
    const lifted = await account("lifted", before);
    await restrict(lifted, { startsAt: at(-8 * 24 * HOUR), liftedAt: at(-5 * 24 * HOUR) });
    await session(lifted, at(2 * HOUR));
    await run(lifted, at(3 * HOUR));
    // Действует всё окно, играл: сессия и два зачтённых забега, третий с читами не входит.
    const active = await account("active", before);
    await restrict(active, { startsAt: at(-8 * 24 * HOUR) });
    await session(active, at(4 * HOUR));
    await run(active, at(5 * HOUR));
    await run(active, at(6 * HOUR));
    await run(active, at(7 * HOUR), true);
    // Начался внутри окна, аккаунт создан в окне, без запуска.
    const starting = await account("starting", at(10 * HOUR));
    await restrict(starting, { startsAt: at(12 * HOUR) });
    // Закончился внутри окна по расчёту — окна достаточно, чтобы быть помеченным.
    const settled = await account("settled", before);
    await restrict(settled, { startsAt: at(-3 * 24 * HOUR), settledAt: at(8 * HOUR) });
    await session(settled, at(9 * HOUR));
    // Не помечены: кончился ровно в начале окна, начался ровно в конце, другой вид.
    const ended = await account("ended", before);
    await restrict(ended, { startsAt: at(-3 * 24 * HOUR), endsAt: FROM });
    const late = await account("late", before);
    await restrict(late, { startsAt: TO });
    const other = await account("other", before);
    await restrict(other, { kind: "leaderboard", startsAt: at(-3 * 24 * HOUR) });
    await session(other, at(HOUR));
  });

  afterAll(async () => {
    await prisma.account.deleteMany({ where: { accountId: { in: Object.values(ids) } } });
    await prisma.$disconnect();
  });

  it("помечен тот, у кого вид действовал в окне хотя бы часть времени", async () => {
    const marked = await markedAccountIds(prisma, FROM, TO);
    expect([...marked].sort()).toEqual([ids.active, ids.starting, ids.settled].sort());
  });

  it("счёты: помеченные, с запуском, созданные в окне, зачтённые забеги без читов", async () => {
    expect(await boardMark(prisma, { from: FROM, to: TO })).toEqual({ marked: 3, active: 2, newAccounts: 1, runs: 2 });
  });

  it("окно без видов — нули", async () => {
    expect(await boardMark(prisma, { from: new Date("2019-01-01T00:00:00Z"), to: new Date("2019-01-02T00:00:00Z") })).toEqual({ marked: 0, active: 0, newAccounts: 0, runs: 0 });
  });

  it("цифры суток для чата от вида не зависят: `day()` до и после равны", async () => {
    const stats = new PrismaDailyStatsRepository(prisma);
    const window = { day: "2020-03-10", from: FROM, to: TO };
    const withViews = await stats.day(window);
    await prisma.accountRestriction.deleteMany({ where: { accountId: { in: Object.values(ids) }, kind: "separate_board" } });
    expect(await stats.day(window)).toEqual(withViews);
    // Виды вернуть не нужно: остальные тесты файла уже отработали.
  });
});
