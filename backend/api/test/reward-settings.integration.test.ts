import "reflect-metadata";
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { AdminSettingsController } from "../src/modules/admin/admin-settings.controller.js";
import { AdminSettingsService } from "../src/modules/admin/admin-settings.service.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { ChangeKindRegistry } from "../src/modules/change-requests/change-request-kinds.js";
import type { ChangeRequestRow, ChangeTx } from "../src/modules/change-requests/change-request-types.js";
import { PrismaChangeRequestsRepository } from "../src/modules/change-requests/change-requests.repository.js";
import { ChangeRequestsService } from "../src/modules/change-requests/change-requests.service.js";
import type { ChangeRequestsNotifier } from "../src/modules/change-requests/change-requests-notifier.js";
import { RewardSettingKind } from "../src/modules/change-requests/reward-settings.js";
import { SkuPriceKind } from "../src/modules/change-requests/sku-price.kind.js";
import { DAILY_BASE, dailyReward, dailyLadderOf, parseDailyLadder, DEFAULT_DAILY_LADDER_TEXT } from "../src/modules/daily/daily-rules.js";
import type { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PrismaItemsRepository } from "../src/modules/items/items.repository.js";
import { ItemsService, cryptoSeeds } from "../src/modules/items/items.service.js";
import { PrismaNotificationsRepository } from "../src/modules/notifications/notifications.repository.js";
import { NotificationsService } from "../src/modules/notifications/notifications.service.js";
import {
  DEFAULT_LEVEL_LADDER_TEXT,
  DEFAULT_RUN_REWARD_LIMITS,
  MAX_COINS_PER_RUN,
  MAX_XP_PER_RUN,
  MIN_REWARDED_SEC,
  levelLadderOf,
  levelReward,
  parseLevelLadder,
  runReward,
} from "../src/modules/progress/progress-rules.js";
import { PrismaProgressRepository } from "../src/modules/progress/progress.repository.js";
import { RunRewards, type RewardJob } from "../src/modules/progress/run-rewards.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { SETTING_LIST, SETTINGS, settingByKey, type SettingDefinition, type SettingValue } from "../src/modules/settings/setting-catalog.js";
import { PrismaSettingsRepository } from "../src/modules/settings/settings.repository.js";
import { SettingsService } from "../src/modules/settings/settings.service.js";
import { ShopOverrides, PrismaShopOverrideRepository } from "../src/modules/shop/shop-overrides.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Награды числами в панели (tasks/T-0310; docs/19-content-admin.md §6). Первая
 * часть — правила без базы: форматы лестниц, умолчания равны прежним
 * постоянным, ключи помечены «деньги». Вторая — живой Postgres (адрес —
 * TEST_DATABASE_URL, без него пропуск): правка ключа «деньги» обычной правкой —
 * 409; заявка → подтверждение другим → следующая награда по новому числу,
 * начисленное не пересчитано; значение выше потолка кошелька — предупреждение
 * в заявке.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const OWNER_ID = "777000444";
const NOW = new Date(Date.UTC(2026, 10, 13, 9));
const HOUR = 3_600_000;
const MONEY_KEYS = ["rewards.run-max-coins", "rewards.run-max-xp", "rewards.run-min-sec", "rewards.level-ladder", "rewards.daily-ladder"];

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error("ожидался отказ");
}

describe("награды: правила без базы", () => {
  it("умолчания ключей — прежние постоянные; ключи помечены «деньги», остальные настройки — нет", () => {
    const money = SETTING_LIST.filter((setting) => setting.money === true).map((setting) => setting.key);
    expect(money.sort()).toEqual([...MONEY_KEYS].sort());
    expect(SETTINGS.rewardsRunMaxCoins.fallback).toBe(MAX_COINS_PER_RUN);
    expect(SETTINGS.rewardsRunMaxXp.fallback).toBe(MAX_XP_PER_RUN);
    expect(SETTINGS.rewardsRunMinSec.fallback).toBe(MIN_REWARDED_SEC);
    expect(SETTINGS.rewardsLevelLadder.fallback).toBe(DEFAULT_LEVEL_LADDER_TEXT);
    expect(SETTINGS.rewardsDailyLadder.fallback).toBe(DEFAULT_DAILY_LADDER_TEXT);
    expect(DEFAULT_RUN_REWARD_LIMITS).toEqual({ minSec: 30, maxCoins: 600, maxXp: 1_500 });
    // Умолчание проходит схему своего же ключа, а окружения у ключей нет.
    for (const key of MONEY_KEYS) {
      const setting = settingByKey(key);
      if (setting === undefined) throw new Error(`нет ключа ${key}`);
      expect(setting.schema.safeParse(setting.fallback).success).toBe(true);
      expect(setting.fromEnv(loadAppConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv))).toBeNull();
    }
  });

  it("лестница уровней по умолчанию даёт прежнюю награду: 50 монет за уровень и 10 самоцветов раз в пять уровней", () => {
    const ladder = levelLadderOf(DEFAULT_LEVEL_LADDER_TEXT);
    for (const level of [1, 4, 5, 20, 99, 100]) {
      expect(levelReward(level, ladder)).toEqual({ coins: 50 * level, gems: level % 5 === 0 ? 10 : 0 });
      expect(levelReward(level)).toEqual(levelReward(level, ladder));
    }
  });

  it("лестница уровней: ступени действуют с указанного уровня; формат строгий", () => {
    const parsed = parseLevelLadder("1:50:10:5; 20:80:20:10");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.text).toBe("1:50:10:5; 20:80:20:10");
    expect(levelReward(19, parsed.ladder)).toEqual({ coins: 950, gems: 0 });
    expect(levelReward(20, parsed.ladder)).toEqual({ coins: 1_600, gems: 20 });
    expect(levelReward(25, parsed.ladder)).toEqual({ coins: 2_000, gems: 0 });
    // Пробелы и порядок знаков приводятся к одному виду, чтобы «было» сравнивалось строкой.
    const loose = parseLevelLadder(" 1:50:10:5 ;20:80:20:10 ");
    expect(loose.ok && loose.text).toBe("1:50:10:5; 20:80:20:10");

    for (const bad of ["", "1:50:10", "2:50:10:5", "1:50:10:5; 1:60:10:5", "1:50:10:5; 0:60:10:5", "1:-5:10:5", "1:50:101:5", "1:50:10:0", "1:1001:10:5", "1:50:10:5; 101:60:10:5", "1:50.5:10:5", "а:б:в:г"]) {
      expect(parseLevelLadder(bad).ok, bad).toBe(false);
    }
    expect(parseLevelLadder(Array.from({ length: 9 }, (_, index) => `${String(index * 10 + 1)}:50:10:5`).join("; ")).ok).toBe(false);
    expect(SETTINGS.rewardsLevelLadder.schema.safeParse("1:50:10:5; 1:60:10:5").success).toBe(false);
    // Битое значение из базы не роняет начисление: действует прежняя лестница.
    expect(levelLadderOf("мусор")).toEqual(levelLadderOf(DEFAULT_LEVEL_LADDER_TEXT));
  });

  it("лестница награды дня: ровно семь дней «монеты/осколки»; по умолчанию — прежняя неделя", () => {
    const parsed = parseDailyLadder(DEFAULT_DAILY_LADDER_TEXT);
    expect(parsed.ok && parsed.ladder).toEqual(DAILY_BASE);
    const ladder = dailyLadderOf(DEFAULT_DAILY_LADDER_TEXT);
    expect(dailyReward(7, 21, ladder)).toEqual({ coins: 420, shards: 10 });
    expect(dailyReward(14, 1, ladder)).toEqual(dailyReward(14, 1));

    const richer = dailyLadderOf("100/0, 120/0, 140/0, 160/0, 200/0, 240/0, 400/20");
    expect(dailyReward(1, 1, richer)).toEqual({ coins: 100, shards: 0 });
    expect(dailyReward(7, 1, richer)).toEqual({ coins: 400, shards: 20 });
    // Ступень недели и уровень множат новую лестницу так же, как прежнюю.
    expect(dailyReward(14, 1, richer)).toEqual({ coins: 460, shards: 23 });

    for (const bad of ["", "60/0", "60/0, 80/0, 100/0, 120/0, 150/0, 180/0", "60/0, 80/0, 100/0, 120/0, 150/0, 180/0, 300/10, 400/10", "0/0, 80/0, 100/0, 120/0, 150/0, 180/0, 300/10", "60/0, 80/0, 100/0, 120/0, 150/0, 180/0, 300/-1", "60, 80, 100, 120, 150, 180, 300", "60/0, 80/0, 100/0, 120/0, 150/0, 180/0, 9999999/10"]) {
      expect(parseDailyLadder(bad).ok, bad).toBe(false);
    }
    expect(dailyLadderOf("мусор")).toEqual(DAILY_BASE);
  });

  it("награда за забег читает потолки и порог из аргумента; без аргумента — прежние числа", () => {
    const run = { difficulty: "hard", survivalSec: 6_000, enemiesKilled: 9_000, level: 100, cheats: false, verdict: "ok" } as const;
    expect(runReward(run)).toMatchObject({ coins: 600, xp: 1_500 });
    expect(runReward(run, { minSec: 30, maxCoins: 800, maxXp: 2_000 })).toMatchObject({ coins: 800, xp: 2_000 });
    expect(runReward(run, { minSec: 30, maxCoins: 100, maxXp: 100 })).toMatchObject({ coins: 100, xp: 100 });
    const short = { ...run, survivalSec: 45 };
    expect(runReward(short).skipped).toBeNull();
    expect(runReward(short, { minSec: 60, maxCoins: 600, maxXp: 1_500 })).toEqual({ coins: 0, xp: 0, skipped: "too_short" });
  });
});

/** Транзакция в памяти: одна таблица `app_setting`, достаточно для вида правки. */
function memoryTx(initial: Record<string, unknown> = {}) {
  const rows = new Map<string, { value: unknown; updatedBy: string | null }>(Object.entries(initial).map(([key, value]) => [key, { value, updatedBy: null }]));
  const tx = {
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const found = rows.get(where.key);
        return found === undefined ? null : { key: where.key, value: found.value, updatedBy: found.updatedBy };
      },
      upsert: async ({ where, create }: { where: { key: string }; create: { value: unknown; updatedBy: string } }) => {
        rows.set(where.key, { value: create.value, updatedBy: create.updatedBy });
        return null;
      },
    },
  };
  return { rows, tx: tx as unknown as ChangeTx };
}

function requestRow(patch: Partial<ChangeRequestRow>): ChangeRequestRow {
  return {
    requestId: randomUUID(),
    kind: "reward_setting",
    target: "rewards.run-max-coins",
    before: { value: 600 },
    after: { value: 800 },
    reason: "причина",
    author: randomUUID(),
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    createdAt: NOW,
    ...patch,
  };
}

describe("награды: вид правки без базы", () => {
  const reloaded: string[] = [];
  const settings = {
    get: <T extends SettingValue>(setting: SettingDefinition<T>): T => setting.fallback,
    refresh: async () => undefined,
    reload: async (key: string) => void reloaded.push(key),
  };
  const kind = new RewardSettingKind(settings);

  it("prepare: «было» — из базы или умолчание; без изменений, вне пределов, не награда — отказ словами", async () => {
    const empty = memoryTx();
    expect(await kind.prepare(empty.tx, "rewards.run-max-coins", { value: 800 })).toEqual({ before: { value: 600 }, after: { value: 800 } });
    const stored = memoryTx({ "rewards.run-max-coins": 700 });
    expect(await kind.prepare(stored.tx, "rewards.run-max-coins", { value: 800 })).toEqual({ before: { value: 700 }, after: { value: 800 } });
    // Лестница приводится к каноническому виду, а «то же значение» узнаётся и с пробелами.
    expect(await kind.prepare(empty.tx, "rewards.level-ladder", { value: " 1:50:10:5 ;20:80:20:10" })).toEqual({ before: { value: "1:50:10:5" }, after: { value: "1:50:10:5; 20:80:20:10" } });
    const refused: [string, unknown][] = [
      ["rewards.run-max-coins", { value: 600 }],
      ["rewards.run-max-coins", { value: 0 }],
      ["rewards.run-max-coins", { value: 1.5 }],
      ["rewards.run-max-coins", { value: "много" }],
      ["rewards.run-max-coins", { value: 800, extra: 1 }],
      ["rewards.run-max-coins", {}],
      ["rewards.run-min-sec", { value: 5 }],
      ["rewards.level-ladder", { value: "1:50:10:5; 1:60:10:5" }],
      ["rewards.level-ladder", { value: "1:50:10:5" }],
      ["rewards.daily-ladder", { value: "60/0" }],
      ["notify.chat.general", { value: "1" }],
      ["rewards.nope", { value: 1 }],
    ];
    for (const [target, input] of refused) {
      await expect(kind.prepare(empty.tx, target, input), `${target} ${JSON.stringify(input)}`).rejects.toMatchObject({ code: "change_request_value_invalid" });
    }
  });

  it("current и apply: правка ложится в app_setting с тем, кто подтвердил; «было» сверяется с базой", async () => {
    const db = memoryTx();
    const request = requestRow({});
    expect(await kind.current(db.tx, request)).toEqual({ value: 600 });
    await kind.apply(db.tx, request, "approver-id");
    expect(db.rows.get("rewards.run-max-coins")).toEqual({ value: 800, updatedBy: "approver-id" });
    expect(await kind.current(db.tx, request)).toEqual({ value: 800 });
    // Битое значение в базе читается как умолчание — так же, как у читателя настройки.
    expect(await kind.current(memoryTx({ "rewards.run-max-coins": "мусор" }).tx, request)).toEqual({ value: 600 });
    // Ключа нет в каталоге — заявка устарела.
    expect(await kind.current(db.tx, requestRow({ target: "rewards.gone" }))).toBeNull();
    await expect(kind.apply(db.tx, requestRow({ after: { value: 0 } }), "x")).rejects.toMatchObject({ code: "change_request_value_invalid" });
    expect(db.rows.get("rewards.run-max-coins")?.value).toBe(800);
  });

  it("afterCommit перечитывает ключ; цели — все пять ключей «деньги» со значением и умолчанием", async () => {
    await kind.afterCommit(requestRow({}));
    expect(reloaded).toEqual(["rewards.run-max-coins"]);
    const targets = await kind.targets();
    expect(targets.map((target) => target.target).sort()).toEqual([...MONEY_KEYS].sort());
    expect(targets.find((target) => target.target === "rewards.run-min-sec")).toMatchObject({ current: { value: 30 }, inCode: { value: 30 }, overridden: false });
    expect(targets.every((target) => typeof target.hint === "string" && target.hint !== "")).toBe(true);
  });

  it("предупреждение о потолке кошелька: выше — есть, в пределах — нет; это совет, не отказ", () => {
    const warn = (target: string, value: number | string) => kind.warnings(requestRow({ target, after: { value } }));
    expect(warn("rewards.run-max-coins", 20_000)).toEqual([]);
    expect(warn("rewards.run-max-coins", 20_001)[0]).toContain("Выше суточного потолка — часть не начислится");
    expect(warn("rewards.run-max-xp", 99_999)).toEqual([]);
    expect(warn("rewards.level-ladder", "1:100:10:5")).toEqual([]);
    expect(warn("rewards.level-ladder", "1:101:10:5")[0]).toContain("монеты за уровень");
    expect(warn("rewards.level-ladder", "1:50:100:1")).toEqual([]);
    expect(warn("rewards.daily-ladder", "60/0, 80/0, 100/0, 120/0, 150/0, 180/0, 300/10")).toEqual([]);
    expect(warn("rewards.daily-ladder", "60/0, 80/0, 100/0, 120/0, 150/0, 180/0, 1100/10")[0]).toContain("монеты награды дня");
    expect(warn("rewards.daily-ladder", "60/0, 80/0, 100/0, 120/0, 150/0, 180/0, 300/70")[0]).toContain("осколки");
    expect(kind.warnings(requestRow({ target: "rewards.gone" }))).toEqual([]);
  });

  it("describe: название и «было → стало» словами", () => {
    expect(kind.describe(requestRow({ before: { value: 600 }, after: { value: 1_500 } }))).toBe("Награда за забег: потолок монет: 600 → 1 500");
    expect(kind.describe(requestRow({ target: "rewards.level-ladder", before: { value: "1:50:10:5" }, after: { value: "1:60:10:5" } }))).toBe("Награды за уровень аккаунта: «1:50:10:5» → «1:60:10:5»");
  });

  it("обычная правка ключей «деньги» закрыта в контроллере — 409 раньше, чем сервис настроек", async () => {
    const controller = new AdminSettingsController({} as unknown as AdminSettingsService, { consume: () => Promise.resolve(true) } as unknown as RateLimiter);
    const request = { account: { accountId: randomUUID(), platform: "telegram", platformUserId: "1" } };
    for (const key of MONEY_KEYS) {
      expect(await codeOf(controller.save(request, key, { value: key.endsWith("ladder") ? "1:50:10:5" : 700 })), key).toBe("change_request_required");
      expect(await codeOf(controller.reset(request, key)), key).toBe("change_request_required");
    }
  });
});

describe.skipIf(DATABASE_URL === "")("награды в панели на живом Postgres", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  const roleAccounts: string[] = [];

  beforeAll(() => {
    config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    prisma = testPrisma(DATABASE_URL, 10);
  });

  async function clean(): Promise<void> {
    await prisma.changeRequest.deleteMany({ where: { kind: "reward_setting" } });
    await prisma.appSetting.deleteMany({ where: { key: { in: MONEY_KEYS } } });
  }

  beforeEach(clean);

  afterAll(async () => {
    await clean();
    await prisma.accountRole.deleteMany({ where: { accountId: { in: roleAccounts } } });
    await prisma.$disconnect();
  });

  function setup() {
    const accounts = new MemoryAccountRepository();
    const roles = new MemoryRolesRepository();
    const redis = { publish: async () => 1 } as unknown as Redis;
    const settings = new SettingsService(config, new PrismaSettingsRepository(prisma), redis);
    const rolesService = new RolesService(config, roles, accounts);
    const notifier = { requested: async () => undefined } as unknown as ChangeRequestsNotifier;
    const kinds = new ChangeKindRegistry([new SkuPriceKind(new ShopOverrides(new PrismaShopOverrideRepository(prisma))), new RewardSettingKind(settings)]);
    const service = new ChangeRequestsService(new PrismaChangeRequestsRepository(prisma), accounts, rolesService, kinds, notifier);
    return { accounts, roles, settings, rolesService, service };
  }
  type Ctx = ReturnType<typeof setup>;

  async function person(ctx: Ctx, id: string, role: "game_designer" | "moderator" | "owner"): Promise<AccountRef> {
    const account = await ctx.accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Участник ${id}`, username: null, photoUrl: null }, Date.now());
    await ctx.roles.grant(account.accountId, role, null);
    return { accountId: account.accountId, platform: "telegram", platformUserId: id };
  }

  const proposal = (target: string, value: number | string, patch: Record<string, unknown> = {}) => ({ kind: "reward_setting", target, after: { value }, reason: "Золотая середина между забегом и уровнем", ...patch });

  it("обычная правка ключа «деньги» — 409 change_request_required, значение не меняется; сброс — тоже; обычный ключ правится как раньше", async () => {
    const ctx = setup();
    const owner = await person(ctx, OWNER_ID, "owner");
    const admin = new AdminSettingsService(ctx.settings, ctx.rolesService);
    const controller = new AdminSettingsController(admin, { consume: () => Promise.resolve(true) } as unknown as RateLimiter);
    const request = { account: owner };

    for (const key of MONEY_KEYS) {
      const refused = controller.save(request, key, { value: key.endsWith("ladder") ? "1:50:10:5" : 700 });
      expect(await codeOf(refused), key).toBe("change_request_required");
      expect(await codeOf(controller.reset(request, key)), key).toBe("change_request_required");
    }
    await expect(controller.save(request, "rewards.run-max-coins", { value: 700 })).rejects.toMatchObject({ status: 409 });
    expect(await prisma.appSetting.count({ where: { key: { in: MONEY_KEYS } } })).toBe(0);
    expect(ctx.settings.get(SETTINGS.rewardsRunMaxCoins)).toBe(600);

    // Неденежная настройка по-прежнему правится сразу.
    const saved = await controller.save(request, SETTINGS.paymentsCompensationMultiplier.key, { value: 3 });
    expect(saved.data.value).toBe(3);
    await prisma.appSetting.deleteMany({ where: { key: SETTINGS.paymentsCompensationMultiplier.key } });
  });

  it("заявка → подтверждение другим → следующая награда по новому числу; начисленное не пересчитано", async () => {
    const ctx = setup();
    const author = await person(ctx, "100", "game_designer");
    const reviewer = await person(ctx, "200", "owner");
    const roles = new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository());
    const wallet = new WalletService(new PrismaWalletRepository(prisma), config, roles);
    const progress = new PrismaProgressRepository(prisma);
    const accounts = new PrismaAccountRepository(prisma);
    const rewards = new RunRewards(
      config,
      new RunsHooks(),
      progress,
      wallet,
      new ItemsService(new PrismaItemsRepository(prisma), wallet, config, cryptoSeeds, new NotificationsService(new PrismaNotificationsRepository(prisma))),
      ctx.settings,
    );
    const player = (await accounts.upsert({ platform: "telegram", platformUserId: String(740_000_000 + Math.floor(Math.random() * 9_000_000)), displayName: "Награждаемый", username: null }, Date.now())).accountId;
    const job = (): RewardJob => ({
      runId: randomUUID(),
      accountId: player,
      difficulty: "hard",
      survivalSec: 2_400,
      enemiesKilled: 9_000,
      level: 1,
      cheats: false,
      verdict: "ok",
      finishedAt: new Date().toISOString(),
    });

    const first = await rewards.grant(job());
    expect(first).toMatchObject({ coins: 600, coinsCredited: 600 });

    const view = await ctx.service.propose(author, proposal("rewards.run-max-coins", 800), NOW);
    expect(view).toMatchObject({ kind: "reward_setting", target: "rewards.run-max-coins", status: "pending", before: { value: 600 }, after: { value: 800 } });
    // До подтверждения число прежнее — и в базе, и у читателя.
    expect(await prisma.appSetting.count({ where: { key: "rewards.run-max-coins" } })).toBe(0);
    expect((await rewards.grant(job())).coins).toBe(600);

    const done = await ctx.service.approve(reviewer, view.requestId, at(HOUR));
    expect(done).toMatchObject({ status: "approved", decidedBy: reviewer.accountId });
    expect(await prisma.appSetting.findUnique({ where: { key: "rewards.run-max-coins" } })).toMatchObject({ key: "rewards.run-max-coins", value: 800, updatedBy: reviewer.accountId });
    expect(ctx.settings.get(SETTINGS.rewardsRunMaxCoins)).toBe(800);

    // Следующая награда — по новому числу, а выданная раньше осталась как была.
    const next = await rewards.grant(job());
    expect(next).toMatchObject({ coins: 800, coinsCredited: 800 });
    expect(await prisma.runReward.findUnique({ where: { runId: first.runId } })).toMatchObject({ coins: 600, coinsCredited: 600 });
  });

  it("порог «забег короче — без награды» и награда за уровень читаются из ключей на каждом начислении", async () => {
    const ctx = setup();
    const author = await person(ctx, "100", "game_designer");
    const reviewer = await person(ctx, "200", "owner");
    const roles = new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository());
    const wallet = new WalletService(new PrismaWalletRepository(prisma), config, roles);
    const rewards = new RunRewards(
      config,
      new RunsHooks(),
      new PrismaProgressRepository(prisma),
      wallet,
      new ItemsService(new PrismaItemsRepository(prisma), wallet, config, cryptoSeeds, new NotificationsService(new PrismaNotificationsRepository(prisma))),
      ctx.settings,
    );
    const player = (await new PrismaAccountRepository(prisma).upsert({ platform: "telegram", platformUserId: String(750_000_000 + Math.floor(Math.random() * 9_000_000)), displayName: "Порог", username: null }, Date.now())).accountId;
    const short = (): RewardJob => ({ runId: randomUUID(), accountId: player, difficulty: "easy", survivalSec: 45, enemiesKilled: 0, level: 1, cheats: false, verdict: "ok", finishedAt: new Date().toISOString() });
    expect((await rewards.grant(short())).skipped).toBeNull();

    const minSec = await ctx.service.propose(author, proposal("rewards.run-min-sec", 60), NOW);
    await ctx.service.approve(reviewer, minSec.requestId, at(HOUR));
    expect((await rewards.grant(short())).skipped).toBe("too_short");

    // Лестница уровней: со следующего уровня награда по новым числам.
    const ladder = await ctx.service.propose(author, proposal("rewards.level-ladder", "1:100:10:5"), at(2 * HOUR));
    expect(ladder).toMatchObject({ before: { value: "1:50:10:5" }, after: { value: "1:100:10:5" } });
    await ctx.service.approve(reviewer, ladder.requestId, at(3 * HOUR));
    expect(ctx.settings.get(SETTINGS.rewardsLevelLadder)).toBe("1:100:10:5");
    const before = (await wallet.balances(player)).coins;
    // 600 с лёгкой на 20-м уровне забега: 100 монет и 195 опыта — это второй уровень аккаунта.
    const row = await rewards.grant({ ...short(), survivalSec: 600, level: 20 });
    expect(row).toMatchObject({ coins: 100, xp: 195, levelBefore: 1, levelAfter: 2 });
    // Награда за второй уровень — по новой лестнице: 100 монет за уровень, а не 50.
    expect((await wallet.balances(player)).coins).toBe(before + 100 + 200);
  });

  it("значение выше потолка кошелька — предупреждение в заявке; в пределах — без него", async () => {
    const ctx = setup();
    const author = await person(ctx, "100", "game_designer");

    const calm = await ctx.service.propose(author, proposal("rewards.run-max-coins", 800), NOW);
    expect(calm.warnings ?? []).toEqual([]);

    // Суточный потолок монет из забегов — 20 000: потолок забега выше него не начислится.
    const run = await ctx.service.propose(author, proposal("rewards.run-max-coins", 25_000), at(HOUR));
    expect(run.warnings?.[0]).toContain("Выше суточного потолка — часть не начислится");

    // Награда уровня на сотом уровне: 150×100 = 15 000 монет при потолке 10 000.
    const level = await ctx.service.propose(author, proposal("rewards.level-ladder", "1:150:10:5"), at(2 * HOUR));
    expect(level.warnings?.[0]).toContain("Выше суточного потолка — часть не начислится");
    const levelOk = await ctx.service.propose(author, proposal("rewards.level-ladder", "1:90:10:5"), at(3 * HOUR));
    expect(levelOk.warnings ?? []).toEqual([]);

    // Награда дня: седьмой день, пятая неделя и сотый уровень множат основу почти в пять раз.
    const daily = await ctx.service.propose(author, proposal("rewards.daily-ladder", "60/0, 80/0, 100/0, 120/0, 150/0, 180/0, 2000/10"), at(4 * HOUR));
    expect(daily.warnings?.[0]).toContain("Выше суточного потолка — часть не начислится");

    // Предупреждение видно и в общем списке, а заявка при этом заведена: это совет, не запрет.
    const overview = await ctx.service.overview(author, at(5 * HOUR));
    expect(overview.requests.find((request) => request.requestId === run.requestId)?.warnings?.length).toBe(1);
    expect(overview.targets.reward_setting?.map((target) => target.target).sort()).toEqual([...MONEY_KEYS].sort());
  });

  it("заявка проверяется схемой ключа до записи: вне пределов, не число, не награда, без изменений — 422", async () => {
    const ctx = setup();
    const author = await person(ctx, "100", "game_designer");
    for (const [target, value] of [
      ["rewards.run-max-coins", 0],
      ["rewards.run-max-coins", 600.5],
      ["rewards.run-max-coins", "много"],
      ["rewards.run-max-coins", 600],
      ["rewards.run-min-sec", 5],
      ["rewards.level-ladder", "1:50:10"],
      ["rewards.daily-ladder", "60/0"],
      ["donate.amounts", "50, 100"],
      ["rewards.nope", 1],
    ] as const) {
      expect(await codeOf(ctx.service.propose(author, proposal(target, value), NOW)), `${target} ${String(value)}`).toBe("change_request_value_invalid");
    }
    expect(await prisma.changeRequest.count({ where: { kind: "reward_setting" } })).toBe(0);
  });

  it("правка ключа мимо заявки между заявкой и подтверждением — 409, заявка заменена, число не перезаписано", async () => {
    const ctx = setup();
    const author = await person(ctx, "100", "game_designer");
    const reviewer = await person(ctx, "200", "owner");
    const view = await ctx.service.propose(author, proposal("rewards.run-max-xp", 2_000), NOW);
    await prisma.appSetting.create({ data: { key: "rewards.run-max-xp", value: 1_800, updatedBy: randomUUID() } });
    expect(await codeOf(ctx.service.approve(reviewer, view.requestId, at(HOUR)))).toBe("change_request_stale");
    expect(await prisma.changeRequest.findUnique({ where: { requestId: view.requestId } })).toMatchObject({ status: "superseded" });
    expect((await prisma.appSetting.findUnique({ where: { key: "rewards.run-max-xp" } }))?.value).toBe(1_800);
  });

  it("свою заявку на награду автор не подтверждает; без права на цены заявку не подать", async () => {
    const ctx = setup();
    const author = await person(ctx, "100", "game_designer");
    const moderator = await person(ctx, "101", "moderator");
    const view = await ctx.service.propose(author, proposal("rewards.run-max-xp", 2_000), NOW);
    expect(await codeOf(ctx.service.approve(author, view.requestId, at(HOUR)))).toBe("change_request_own");
    expect(await codeOf(ctx.service.propose(moderator, proposal("rewards.run-max-xp", 2_100), NOW))).toBe("forbidden");
    expect(await prisma.appSetting.count({ where: { key: "rewards.run-max-xp" } })).toBe(0);
  });
});
