import { randomInt } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "../src/common/domain-error.js";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaBattlePassRepository } from "../src/modules/battle-pass/battle-pass.repository.js";
import { BattlePassService } from "../src/modules/battle-pass/battle-pass.service.js";
import { DEFAULT_RIBBON } from "../src/modules/battle-pass/pass-defaults.js";
import { PassSeasonExistsError, PassSeasonNotFoundError, PassSeasonReadonlyError, PassTierPassedError } from "../src/modules/battle-pass/pass-errors.js";
import { PassAdminService } from "../src/modules/battle-pass/pass-admin.service.js";
import { PrismaPassSeasonRepository } from "../src/modules/battle-pass/pass-season.repository.js";
import { tierEditSchema, type PassTierDef } from "../src/modules/battle-pass/pass-rules.js";
import type { Permission } from "../src/modules/roles/permissions.js";
import type { AccountRef, RolesService } from "../src/modules/roles/roles.service.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Ленты батл-пасса в панели на живом Postgres (tasks/T-0313; адрес —
 * TEST_DATABASE_URL, без него пропуск). Память не покажет главного: «кто-то
 * уже на 7-й ступени» — это `MAX(points)` по таблице игроков, а «игрок не видит
 * неопубликованный месяц» — запрос ленты, который читает забор награды.
 *
 * Месяцы — из далёкого будущего: «сейчас» подставляется параметром, а база
 * общая для всех прогонов, и очки чужих тестов в 2026-м сделали бы «наибольшую
 * достигнутую ступень» случайной.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const live = DATABASE_URL !== "";

/** Для месяцев ниже — «сегодня»: 12.04.2033, 12:00 по Москве */
const NOW = new Date("2033-04-12T09:00:00Z");
const PAST = "2033-03";
const CURRENT = "2033-04";
const NEXT = "2033-05";
const MONTHS = [PAST, CURRENT, NEXT];

const ACTOR: AccountRef = { accountId: "00000000-0000-4000-8000-000000000001", platform: "telegram", platformUserId: "1" };

/** Бесплатная и VIP награда ступени с узнаваемыми числами. */
function reward(coins: number) {
  return { free: { coins }, vip: { gems: 11 } };
}

describe.skipIf(!live)("ленты батл-пасса в панели на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let passRepository: PrismaBattlePassRepository;
  let service: PassAdminService;
  let player: BattlePassService;
  const audits: { action: string; target?: string | undefined; before?: unknown; after?: unknown }[] = [];
  let granted = new Set<Permission>(["pass.edit"]);

  const roles = {
    require: async (_actor: AccountRef, permission: Permission) => {
      if (!granted.has(permission)) throw new ForbiddenError("Недостаточно прав");
    },
    audit: async (entry: { action: string; target?: string | undefined; before?: unknown; after?: unknown }) => {
      audits.push(entry);
    },
  } as unknown as RolesService;

  async function accountId(): Promise<string> {
    const row = await accounts.upsert({ platform: "telegram", platformUserId: String(950_000_000 + randomInt(0, 40_000_000)), displayName: "Пасс-панель", username: null, photoUrl: null }, Date.now());
    return row.accountId;
  }

  /** Игрок набрал очки на нужную ступень месяца (шаг ступени — 100 очков по умолчанию). */
  async function reach(tier: number, month = CURRENT): Promise<void> {
    await passRepository.addPoints(await accountId(), month, tier * 100, NOW);
  }

  /** Месяц напрямую в базу — прошлое, которое через панель завести уже нельзя. */
  async function seed(month: string, tiers: readonly PassTierDef[], published: boolean): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO pass_season (month_key, tiers, published_at)
      VALUES (${month}, ${JSON.stringify(tiers)}::jsonb, ${published ? NOW.toISOString() : "infinity"}::timestamptz)
      ON CONFLICT (month_key) DO NOTHING`;
  }

  const customRibbon = DEFAULT_RIBBON.map((tier) => (tier.tier === 1 ? { ...tier, ...reward(777) } : tier));

  beforeAll(async () => {
    prisma = createPrisma(loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv));
    accounts = new PrismaAccountRepository(prisma);
    passRepository = new PrismaBattlePassRepository(prisma);
    const settings = panelSettings();
    service = new PassAdminService(new PrismaPassSeasonRepository(prisma), settings, roles);
    player = new BattlePassService(passRepository, {} as never, { activeAt: async () => false }, settings);
  });

  beforeEach(async () => {
    granted = new Set<Permission>(["pass.edit"]);
    audits.length = 0;
    for (const month of MONTHS) {
      await prisma.$executeRaw`DELETE FROM pass_season WHERE month_key = ${month}`;
      await prisma.$executeRaw`DELETE FROM pass_progress WHERE month_key = ${month}`;
    }
  });

  afterAll(async () => {
    for (const month of MONTHS) {
      await prisma.$executeRaw`DELETE FROM pass_season WHERE month_key = ${month}`;
      await prisma.$executeRaw`DELETE FROM pass_progress WHERE month_key = ${month}`;
    }
    await prisma.$disconnect();
  });

  describe("месяцы", () => {
    it("список — текущий, следующий и прошлые месяцы с лентой; у текущего без своей ленты — «не заведён»", async () => {
      await seed(PAST, customRibbon, true);
      const view = await service.seasons(ACTOR, NOW);
      expect(view.currentMonth).toBe(CURRENT);
      expect(view.nextMonth).toBe(NEXT);
      const byMonth = new Map(view.months.map((row) => [row.monthKey, row]));
      expect(byMonth.get(PAST)).toMatchObject({ phase: "past", saved: true, published: true });
      expect(byMonth.get(CURRENT)).toMatchObject({ phase: "current", saved: false, published: false });
      expect(byMonth.get(NEXT)).toMatchObject({ phase: "future", saved: false, published: false });
    });

    it("месяц без своей ленты показывает ленту по умолчанию", async () => {
      const view = await service.season(ACTOR, NEXT, NOW);
      expect(view.saved).toBe(false);
      expect(view.tiers).toEqual(DEFAULT_RIBBON);
    });
  });

  describe("создание", () => {
    it("копия прошлого месяца даёт те же 30 ступеней и не опубликована", async () => {
      await seed(PAST, customRibbon, true);
      const created = await service.create(ACTOR, { month: NEXT, from: PAST }, NOW);
      expect(created).toMatchObject({ monthKey: NEXT, phase: "future", saved: true, published: false });
      expect(created.tiers).toHaveLength(30);
      expect(created.tiers).toEqual(customRibbon);
      expect(audits.map((entry) => entry.action)).toEqual(["pass.season.create"]);
    });

    it("без источника — лента по умолчанию", async () => {
      const created = await service.create(ACTOR, { month: NEXT }, NOW);
      expect(created.tiers).toEqual(DEFAULT_RIBBON);
    });

    it("месяц, который уже заведён, второй раз не создаётся", async () => {
      await service.create(ACTOR, { month: NEXT }, NOW);
      await expect(service.create(ACTOR, { month: NEXT }, NOW)).rejects.toBeInstanceOf(PassSeasonExistsError);
    });

    it("в прошлом месяце ленту не заводят", async () => {
      await expect(service.create(ACTOR, { month: PAST }, NOW)).rejects.toBeInstanceOf(PassSeasonReadonlyError);
    });
  });

  describe("правка ступени", () => {
    it("текущий месяц: ступень, которую уже прошёл игрок, — 409 «Эту ступень уже прошли игроки»", async () => {
      await service.create(ACTOR, { month: CURRENT }, NOW);
      await reach(7);
      const error = await service.editTier(ACTOR, CURRENT, 5, reward(500), NOW).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PassTierPassedError);
      expect(error).toMatchObject({ status: 409, message: "Эту ступень уже прошли игроки" });
      // граница включена: на 7-й стоит игрок — седьмая тоже закрыта
      await expect(service.editTier(ACTOR, CURRENT, 7, reward(500), NOW)).rejects.toBeInstanceOf(PassTierPassedError);
      expect((await service.season(ACTOR, CURRENT, NOW)).tiers[4]).toEqual(DEFAULT_RIBBON[4]);
    });

    it("текущий месяц: ступень 20, до которой никто не дошёл, правится и уходит в аудит «было → стало»", async () => {
      await service.create(ACTOR, { month: CURRENT }, NOW);
      await reach(7);
      const view = await service.editTier(ACTOR, CURRENT, 20, reward(900), NOW);
      expect(view.tiers[19]).toEqual({ tier: 20, ...reward(900) });
      expect(view.tiers[18]).toEqual(DEFAULT_RIBBON[18]);
      const entry = audits.find((candidate) => candidate.action === "pass.tier.update");
      expect(entry?.target).toBe(`${CURRENT}:20`);
      expect(entry?.before).toEqual(DEFAULT_RIBBON[19]);
      expect(entry?.after).toEqual({ tier: 20, ...reward(900) });
      expect((await service.season(ACTOR, CURRENT, NOW)).lockedTiers).toBe(7);
    });

    it("будущий месяц правится целиком, ступень 1 — тоже", async () => {
      await service.create(ACTOR, { month: NEXT }, NOW);
      const view = await service.editTier(ACTOR, NEXT, 1, reward(321), NOW);
      expect(view.tiers[0]).toEqual({ tier: 1, ...reward(321) });
    });

    it("прошлый месяц — только чтение", async () => {
      await seed(PAST, customRibbon, true);
      await expect(service.editTier(ACTOR, PAST, 25, reward(10), NOW)).rejects.toBeInstanceOf(PassSeasonReadonlyError);
    });

    it("месяца без своей ленты правка не создаёт: сначала «Создать»", async () => {
      await expect(service.editTier(ACTOR, NEXT, 3, reward(10), NOW)).rejects.toBeInstanceOf(PassSeasonNotFoundError);
    });

    it("лента, выходящая за суточный потолок кошелька, не сохраняется", async () => {
      await service.create(ACTOR, { month: NEXT }, NOW);
      await expect(service.editTier(ACTOR, NEXT, 2, { free: { coins: 1_000_000 }, vip: { gems: 1 } }, NOW)).rejects.toBeInstanceOf(ValidationError);
      expect((await service.season(ACTOR, NEXT, NOW)).tiers[1]).toEqual(DEFAULT_RIBBON[1]);
    });
  });

  describe("награда по схеме, без случайного", () => {
    it("лишнее поле — случайный шанс, «случайный осколок» — отказ схемой", () => {
      expect(tierEditSchema.safeParse({ free: { coins: 5, chance: 0.5 }, vip: { gems: 1 } }).success).toBe(false);
      expect(tierEditSchema.safeParse({ free: { coins: 5 }, vip: { randomShard: 1 } }).success).toBe(false);
      expect(tierEditSchema.safeParse({ free: { shards: { random: 1 } }, vip: { gems: 1 } }).success).toBe(false);
      expect(tierEditSchema.safeParse({ free: { coins: 5 }, vip: { gems: 1 }, tier: 3 }).success).toBe(false);
    });

    it("пустая награда и награда без одной из лент — отказ", () => {
      expect(tierEditSchema.safeParse({ free: {}, vip: { gems: 1 } }).success).toBe(false);
      expect(tierEditSchema.safeParse({ free: { coins: 5 } }).success).toBe(false);
    });

    it("обычная награда проходит", () => {
      expect(tierEditSchema.safeParse({ free: { coins: 5, shards: { common: 2 }, boost: { id: "fury", count: 1 } }, vip: { gems: 3 } }).success).toBe(true);
    });
  });

  describe("публикация", () => {
    it("неопубликованный месяц игрок не видит: действует лента по умолчанию, а после публикации — своя", async () => {
      await seed(CURRENT, customRibbon, false);
      expect((await player.view({ accountId: await accountId(), platform: "telegram", platformUserId: "1" }, NOW)).tiers[0]?.free).toEqual(DEFAULT_RIBBON[0]?.free);
      const published = await service.publish(ACTOR, CURRENT, NOW);
      expect(published).toMatchObject({ published: true });
      const view = await player.view({ accountId: await accountId(), platform: "telegram", platformUserId: "1" }, NOW);
      expect(view.tiers[0]?.free).toEqual({ coins: 777 });
      expect(audits.map((entry) => entry.action)).toContain("pass.season.publish");
    });

    it("текущий месяц: лента, меняющая уже пройденную игроками ступень, не публикуется", async () => {
      await seed(CURRENT, customRibbon, false);
      await reach(3);
      await expect(service.publish(ACTOR, CURRENT, NOW)).rejects.toBeInstanceOf(PassTierPassedError);
      expect((await service.season(ACTOR, CURRENT, NOW)).published).toBe(false);
    });

    it("текущий месяц: лента, не трогающая пройденное, публикуется", async () => {
      await seed(CURRENT, DEFAULT_RIBBON.map((tier) => (tier.tier === 12 ? { ...tier, ...reward(1_000) } : tier)), false);
      await reach(3);
      expect((await service.publish(ACTOR, CURRENT, NOW)).published).toBe(true);
    });

    it("повторная публикация ничего не пишет в аудит; прошлый месяц и месяц без ленты — отказ", async () => {
      await service.create(ACTOR, { month: NEXT }, NOW);
      await service.publish(ACTOR, NEXT, NOW);
      audits.length = 0;
      expect((await service.publish(ACTOR, NEXT, NOW)).published).toBe(true);
      expect(audits).toEqual([]);
      await seed(PAST, customRibbon, false);
      await expect(service.publish(ACTOR, PAST, NOW)).rejects.toBeInstanceOf(PassSeasonReadonlyError);
      await prisma.$executeRaw`DELETE FROM pass_season WHERE month_key = ${NEXT}`;
      await expect(service.publish(ACTOR, NEXT, NOW)).rejects.toBeInstanceOf(PassSeasonNotFoundError);
    });
  });

  describe("права", () => {
    it("без pass.edit каждое действие — 403 и ничего не пишется", async () => {
      granted = new Set<Permission>();
      await expect(service.seasons(ACTOR, NOW)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(service.season(ACTOR, NEXT, NOW)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(service.create(ACTOR, { month: NEXT }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(service.editTier(ACTOR, NEXT, 1, reward(10), NOW)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(service.publish(ACTOR, NEXT, NOW)).rejects.toBeInstanceOf(ForbiddenError);
      const rows = await prisma.$queryRaw<unknown[]>`SELECT 1 FROM pass_season WHERE month_key = ${NEXT}`;
      expect(rows).toEqual([]);
      expect(audits).toEqual([]);
    });
  });
});
