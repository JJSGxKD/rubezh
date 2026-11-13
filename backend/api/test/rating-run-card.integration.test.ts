import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { bundledExpectedTable, expectedRowOf, type ExpectedTable } from "../src/modules/rating/expected-table.js";
import { PrismaRunCardRepository, RunCardService } from "../src/modules/rating/run-card.service.js";
import { RunScorer } from "../src/modules/rating/run-scorer.service.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { runFinishSchema, type RunFinish } from "../src/modules/runs/dto/runs.dto.js";
import { RunContinues } from "../src/modules/runs/run-continues.js";
import { RunLoadouts } from "../src/modules/runs/run-loadouts.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { PrismaRunsRepository } from "../src/modules/runs/runs.repository.js";
import { RunsService } from "../src/modules/runs/runs.service.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRestrictionsRepository, restrictionsGate } from "./helpers/memory-restrictions.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryLeaderboardStore, ratingRestrictions } from "./helpers/memory-runs.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Карточка рейтингового забега на настоящем Postgres (tasks/T-0297). Адрес —
 * TEST_DATABASE_URL; без него файл пропускается. Память не покажет главного:
 * что чужому не уходит ни аккаунт, ни площадка, и что видимость решает строка
 * забега и ограничение рейтинга, а не догадка сервиса.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const live = DATABASE_URL !== "";

describe.skipIf(!live)("карточка забега на живом Postgres", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let table: ExpectedTable;
  const memory = new MemoryRestrictionsRepository();

  async function account(name = "Дым"): Promise<AccountRef> {
    const platformUserId = String(900_000_000 + Math.floor(Math.random() * 90_000_000));
    const created = await accounts.upsert({ platform: "telegram", platformUserId, displayName: name, username: "hidden_name", photoUrl: null }, Date.now());
    return { accountId: created.accountId, platform: "telegram", platformUserId };
  }

  function recorder(): RunsService {
    const runs = new PrismaRunsRepository(prisma);
    const board = new MemoryLeaderboardStore();
    const roles = new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository());
    const scorer = new RunScorer({ get: () => table }, panelSettings(), null);
    return new RunsService(config, runs, board, roles, new RunsHooks(), new RunContinues(), new RunLoadouts(), ratingRestrictions(runs, board).rating, undefined, scorer);
  }

  function cards(source: ExpectedTable | null = table): RunCardService {
    const settings = panelSettings();
    return new RunCardService(new PrismaRunCardRepository(prisma), { get: () => source }, new RunScorer({ get: () => source }, settings, null), settings, restrictionsGate(memory));
  }

  function finish(patch: Partial<RunFinish> = {}): RunFinish {
    const row = expectedRowOf(table, "average", 10);
    return runFinishSchema.parse({
      runId: randomUUID(),
      difficultyId: "hard",
      outcome: "died",
      survivalSec: 600,
      level: 18,
      enemiesKilled: Math.floor(row.killsPerMin * 10),
      startingWeaponId: "knife",
      weapons: [
        { id: "knife", level: 4, damage: 900 },
        { id: "spark", level: 2, damage: 100 },
      ],
      passives: [{ id: "might", level: 3 }],
      contentHash: table.contentHash,
      stats: {
        damageTaken: Math.ceil(row.damageTakenPerMin * 10),
        xpCollected: 100,
        waveReached: 10,
        topKills: [],
        bossKills: 1,
        eliteKills: 4,
        huntLog: [{ rank: "elite", value: row.huntPerMin * 10, aliveSec: row.huntKillSec.elite }],
        buildScore: row.buildScore,
        power: 2.2,
      },
      ...patch,
    });
  }

  /** Записать забег игрока и вернуть его ключ. */
  async function played(owner: AccountRef, patch: Partial<RunFinish> = {}): Promise<string> {
    const run = finish(patch);
    await recorder().finish(owner, run);
    return run.runId;
  }

  beforeAll(() => {
    config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    accounts = new PrismaAccountRepository(prisma);
    const bundled = bundledExpectedTable();
    if (bundled === null) throw new Error("таблица ожидаемого не разобралась");
    table = bundled;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("чужой рейтинговый забег — 200: очки, пять осей, сборка; без аккаунта, площадки и времени записи", async () => {
    const owner = await account("Велимир");
    const viewer = await account();
    const runId = await played(owner);
    await prisma.run.update({ where: { runId }, data: { ranked: true } });

    const card = await cards().card(viewer.accountId, runId);

    expect(card.runId).toBe(runId);
    expect(card.mine).toBe(false);
    expect(card.player.name).toBe("Велимир");
    expect(card.points).toBeGreaterThan(900);
    expect(card.axes.map((axis) => axis.axis)).toEqual(["t", "k", "h", "c", "b"]);
    expect(card.axes.every((axis) => axis.points >= 0 && axis.expectedPoints > 0)).toBe(true);
    expect(card.build.weapons.map((weapon) => weapon.id)).toEqual(["knife", "spark"]);
    expect(card.build.passives).toEqual([{ id: "might", level: 3 }]);
    expect(card.facts.bossKills).toBe(1);
    expect(card.facts.eliteKills).toBe(4);

    const text = JSON.stringify(card);
    expect(text).not.toContain(owner.accountId);
    expect(text).not.toContain(owner.platformUserId);
    expect(text).not.toContain("hidden_name");
    expect(text).not.toContain("telegram");
    expect(text).not.toContain("finishedAt");
    expect(text).not.toContain("accountId");
  });

  it("чужой нерейтинговый забег — 404", async () => {
    const owner = await account();
    const viewer = await account();
    const runId = await played(owner);
    await prisma.run.update({ where: { runId }, data: { ranked: false } });

    await expect(cards().card(viewer.accountId, runId)).rejects.toMatchObject({ status: 404 });
  });

  it("незнакомый забег и незаконченный забег — 404", async () => {
    const viewer = await account();

    await expect(cards().card(viewer.accountId, randomUUID())).rejects.toMatchObject({ status: 404 });
  });

  it("забег ограниченного игрока чужому — 404, ему самому — 200", async () => {
    const owner = await account();
    const viewer = await account();
    const runId = await played(owner);
    await prisma.run.update({ where: { runId }, data: { ranked: true } });
    await memory.impose([{ accountId: owner.accountId, kind: "leaderboard", startsAt: new Date(Date.now() - 1_000), endsAt: null, reason: "other", comment: null, notify: true, imposedBy: null }], new Date());

    await expect(cards().card(viewer.accountId, runId)).rejects.toMatchObject({ status: 404 });
    const own = await cards().card(owner.accountId, runId);

    expect(own.mine).toBe(true);
    expect(own.runId).toBe(runId);
  });

  it("свой нерейтинговый забег — 200", async () => {
    const owner = await account();
    const runId = await played(owner);
    await prisma.run.update({ where: { runId }, data: { ranked: false } });

    const card = await cards().card(owner.accountId, runId);

    expect(card.mine).toBe(true);
    expect(card.points).toBeGreaterThan(0);
  });

  it("забег без очков (пролог, сбой подсчёта) карточки не имеет даже у хозяина", async () => {
    const owner = await account();
    const runId = await played(owner, { difficultyId: "easy" });

    await expect(cards().card(owner.accountId, runId)).rejects.toMatchObject({ status: 404 });
  });

  it("бусты забега попадают в сборку, возвращённые — нет", async () => {
    const owner = await account();
    const viewer = await account();
    const runId = await played(owner);
    await prisma.run.update({ where: { runId }, data: { ranked: true } });
    await prisma.runBoost.create({ data: { runId, accountId: owner.accountId, boosts: ["aegis"], cost: { coins: 10 }, createdAt: new Date() } });

    expect((await cards().card(viewer.accountId, runId)).build.boosts).toEqual(["aegis"]);

    await prisma.runBoost.update({ where: { runId }, data: { refundedAt: new Date() } });
    expect((await cards().card(viewer.accountId, runId)).build.boosts).toEqual([]);
  });

  it("таблицы ожидаемого нет — карточка есть, чистота без процента", async () => {
    const owner = await account();
    const runId = await played(owner);
    await prisma.run.update({ where: { runId }, data: { ranked: true } });

    const card = await cards(null).card(owner.accountId, runId);

    expect(card.facts.damageDeltaPct).toBeNull();
    expect(card.points).toBeGreaterThan(0);
  });
});
